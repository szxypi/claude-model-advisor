// Reads a bounded excerpt of the host Claude Code transcript so the advisor sees what the executor
// has actually done, instead of only the evidence the executor remembered to attach.
//
// Every read is bounded before anything is parsed: a byte window off the end of the file, a byte
// window off the front for the opening task, a message count, a per-message clip, and a total
// excerpt budget. Nothing here grows with the size of the session.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code stores <projects>/<cwd with every non-alphanumeric byte turned into a dash>/<session>.jsonl.
export const projectSlug = dir => dir.replace(/[^a-zA-Z0-9]/g, '-');
const PROJECTS_SCAN_LIMIT = 500;

export async function findTranscript(env = process.env, home = env.HOME || env.USERPROFILE || homedir()) {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session || !/^[0-9a-fA-F-]{8,64}$/.test(session)) return undefined;
  const root = join(home, '.claude', 'projects');
  const file = `${session}.jsonl`;
  const readable = async path => { try { return (await stat(path)).isFile() ? path : undefined; } catch { return undefined; } };
  if (env.CLAUDE_PROJECT_DIR) {
    const direct = await readable(join(root, projectSlug(env.CLAUDE_PROJECT_DIR), file));
    if (direct) return direct;
  }
  // The slug rule is host-internal, so fall back to a single-level scan keyed by the session UUID.
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries.slice(0, PROJECTS_SCAN_LIMIT)) {
    if (!entry.isDirectory()) continue;
    const hit = await readable(join(root, entry.name, file));
    if (hit) return hit;
  }
  return undefined;
}

function clip(value, maxBytes) {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes - 16);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${new TextDecoder('utf-8').decode(buf.subarray(0, end))}…[clipped]`;
}

function blockText(block, toolInputBytes) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text': return typeof block.text === 'string' ? block.text : '';
    // Thinking is dropped: it is the executor's private reasoning and the most expensive
    // part of the transcript, and the advisor is being asked to reason independently.
    case 'thinking': case 'redacted_thinking': return '';
    // A tool call's arguments are the cheapest thing to lose: what the advisor needs is which tool
    // ran and what came back, not a verbatim 4 KB heredoc crowding out the result beneath it.
    case 'tool_use': return `[tool ${block.name ?? '?'}] ${clip(safeJSON(block.input), toolInputBytes)}`;
    case 'tool_result': return `[tool result${block.is_error ? ' ERROR' : ''}] ${contentText(block.content, toolInputBytes)}`;
    default: return '';
  }
}
function safeJSON(value) {
  if (value === undefined) return '';
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}
function contentText(content, toolInputBytes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeJSON(content);
  return content.map(block => blockText(block, toolInputBytes)).filter(Boolean).join('\n');
}

// One transcript record -> one rendered turn, or undefined when it carries nothing useful.
export const TOOL_INPUT_SHARE = 4;
export function renderRecord(record, maxItemBytes) {
  if (!record || typeof record !== 'object') return undefined;
  if (record.type !== 'user' && record.type !== 'assistant') return undefined;
  // Subagent threads are a different conversation; the advisor is advising the main one.
  if (record.isSidechain) return undefined;
  const toolInputBytes = Math.max(200, Math.floor(maxItemBytes / TOOL_INPUT_SHARE));
  const body = contentText(record.message?.content, toolInputBytes).trim();
  if (!body) return undefined;
  return { role: record.type, text: clip(body, maxItemBytes) };
}

function parseLines(buffer, dropFirstPartial) {
  const lines = new TextDecoder('utf-8').decode(buffer).split('\n');
  if (dropFirstPartial) lines.shift();
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* A clipped or half-written line is simply skipped. */ }
  }
  return out;
}

async function readWindow(handle, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

export const TRANSCRIPT_DEFAULTS = Object.freeze({ maxBytes: 24576, maxTurns: 40, maxItemBytes: 2000 });
// Below this there is no room for a useful excerpt, so none is sent at all.
export const MIN_TRANSCRIPT_BYTES = 1024;
const HEAD_BYTES = 65536;
const TAIL_MULTIPLIER = 8;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export async function readTranscript(path, options = {}) {
  const { maxBytes, maxTurns, maxItemBytes } = { ...TRANSCRIPT_DEFAULTS, ...options };
  if (!(maxBytes >= MIN_TRANSCRIPT_BYTES)) return undefined;
  let handle;
  try { handle = await open(path, 'r'); } catch { return undefined; }
  try {
    const size = (await handle.stat()).size;
    const tailBytes = Math.min(size, MAX_TAIL_BYTES, Math.max(maxBytes * TAIL_MULTIPLIER, 131072));
    const tailStart = size - tailBytes;
    const tail = parseLines(await readWindow(handle, tailStart, tailBytes), tailStart > 0);
    const head = tailStart > 0 ? parseLines(await readWindow(handle, 0, Math.min(HEAD_BYTES, tailStart)), false) : [];
    const render = records => records.map(r => renderRecord(r, maxItemBytes)).filter(Boolean);
    const rendered = render(tail);
    // When the whole file fits in the tail window there is no separate head to look in.
    const opening = (tailStart > 0 ? render(head) : rendered).find(t => t.role === 'user');
    const turns = rendered.slice(-maxTurns);
    if (!turns.length && !opening) return undefined;
    const line = t => `${t.role}: ${t.text}`;
    const cost = value => Buffer.byteLength(value, 'utf8') + 1;
    const openingLine = opening && `session start (user): ${clip(opening.text, Math.floor(maxBytes / 4))}`;
    // The opening task is the one turn the advisor cannot reconstruct from the rest, so hold space
    // for it before filling the budget backwards from the newest turn — unless it would eat the half.
    const openingCost = openingLine ? cost(openingLine) : 0;
    const reserve = openingCost && openingCost < maxBytes / 2 ? openingCost : 0;
    let first = turns.length;
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const next = cost(line(turns[i]));
      if (used + next > maxBytes - reserve) break;
      used += next;
      first = i;
    }
    const kept = turns.slice(first).map(line);
    // Everything between the head window and the tail window was never parsed, so it cannot be
    // counted. Say that outright rather than let dropped_older_turns imply nothing is missing.
    const windowed = tailStart > 0;
    if (windowed) {
      const marker = '…[earlier turns not read: only the opening task and the most recent turns were loaded]';
      if (used + cost(marker) <= maxBytes) { kept.unshift(marker); used += cost(marker); }
    }
    const openingIndex = opening ? turns.indexOf(opening) : -1;
    const alreadyKept = openingIndex >= first && openingIndex !== -1;
    if (openingLine && !alreadyKept && used + openingCost <= maxBytes) {
      kept.unshift(openingLine);
      used += openingCost;
    }
    if (!kept.length) return undefined;
    return { excerpt: kept.join('\n'), turns: kept.length, earlier_turns_not_read: windowed,
      dropped_older_turns: rendered.length - turns.length + first, bytes: used };
  } catch { return undefined; } finally { await handle.close().catch(() => {}); }
}
