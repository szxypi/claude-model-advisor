// Read-only local panel for the consultation ledger. Binds to 127.0.0.1 only.
// Usage: node scripts/panel.mjs [--port N] [--history /abs/path/history.jsonl] [--no-open]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { loadConfig, defaultHistoryPath } from '../src/core.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let port = Number(flag('--port') ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('Invalid --port'); process.exit(1); }
let historyPath = flag('--history');
if (historyPath !== undefined && !isAbsolute(historyPath)) { console.error('--history must be an absolute path'); process.exit(1); }
if (historyPath === undefined) {
  try { historyPath = (await loadConfig()).history.path; } catch { historyPath = defaultHistoryPath(); }
}
const pageHtml = await readFile(fileURLToPath(new URL('./panel.html', import.meta.url)), 'utf8');

async function loadRecords() {
  let raw;
  try { raw = await readFile(historyPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

function summarize(records) {
  const byProfile = {};
  for (const r of records) {
    const p = byProfile[r.profile] ??= { calls: 0, ok: 0, failed: 0, fallback_in: 0, total_ms: 0, models: {} };
    p.calls++; r.ok ? p.ok++ : p.failed++;
    if (r.fallback_from) p.fallback_in++;
    p.total_ms += r.duration_ms ?? 0;
    if (r.requested_model) p.models[r.requested_model] = (p.models[r.requested_model] ?? 0) + 1;
  }
  const errors = {};
  for (const r of records) if (!r.ok && r.error_code) errors[r.error_code] = (errors[r.error_code] ?? 0) + 1;
  return { total: records.length, ok: records.filter(r => r.ok).length, fallbacks: records.filter(r => r.fallback_from).length,
    by_profile: byProfile, errors, first_ts: records[0]?.ts ?? null, last_ts: records.at(-1)?.ts ?? null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:");
  if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
  try {
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pageHtml); return;
    }
    if (url.pathname === '/api/ledger') {
      const records = await loadRecords();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ history_path: historyPath, generated_at: new Date().toISOString(), summary: summarize(records), records }));
      return;
    }
    res.statusCode = 404; res.end();
  } catch (e) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.code === 'EACCES' ? '台账文件不可读。' : '读取台账失败。' }));
  }
});
server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${server.address().port}/`;
  console.log(`顾问咨询台账面板：${address}`);
  console.log(`台账文件：${historyPath}`);
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]]
      : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
  }
});
