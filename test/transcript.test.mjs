import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, findTranscript, readTranscript, renderRecord, TRANSCRIPT_DEFAULTS } from '../src/transcript.mjs';
import { validateConfig, createAdvisor } from '../src/core.mjs';

const SESSION = '11111111-aaaa-2222-bbbb-333333333333';
const isCode = code => e => e.code === code;
const user = text => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = blocks => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });

async function withHome(lines, fn, { dir = '/home/u/work' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'advisor-home-'));
  const projects = join(home, '.claude', 'projects', projectSlug(dir));
  await mkdir(projects, { recursive: true });
  const path = join(projects, `${SESSION}.jsonl`);
  await writeFile(path, `${lines.join('\n')}\n`);
  try { return await fn({ home, path, env: { HOME: home, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir } }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test('projectSlug turns every non-alphanumeric byte into a dash', () => {
  assert.equal(projectSlug('/home/dev/projects/my_app/api'), '-home-dev-projects-my-app-api');
  assert.equal(projectSlug('/a/.claude-worktrees/x'), '-a--claude-worktrees-x');
});

test('findTranscript resolves by slug, falls back to a scan, and needs a session id', async () => {
  await withHome([user('hi')], async ({ path, env, home }) => {
    assert.equal(await findTranscript(env), path);
    // A wrong project dir still resolves: the single-level scan is keyed by the session UUID.
    assert.equal(await findTranscript({ ...env, CLAUDE_PROJECT_DIR: '/some/other/place' }), path);
    assert.equal(await findTranscript({ HOME: home }), undefined);
    assert.equal(await findTranscript({ HOME: home, CLAUDE_CODE_SESSION_ID: 'not a uuid at all!!' }), undefined);
    assert.equal(await findTranscript({ ...env, CLAUDE_CODE_SESSION_ID: '99999999-cccc-8888-dddd-777777777777' }), undefined);
  });
});

test('renderRecord keeps text and tools, drops thinking, sidechains and empties', () => {
  const clip = TRANSCRIPT_DEFAULTS.maxItemBytes;
  assert.equal(renderRecord({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }] } }, clip), undefined);
  assert.equal(renderRecord({ type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }, clip), undefined);
  assert.equal(renderRecord({ type: 'system', message: { content: 'x' } }, clip), undefined);
  const tool = renderRecord({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'do not send this' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
  ] } }, clip);
  assert.equal(tool.role, 'assistant');
  assert.ok(!tool.text.includes('do not send this'));
  assert.match(tool.text, /\[tool Bash\] \{"command":"ls"\}/);
  const res = renderRecord({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } }, clip);
  assert.equal(res.text, '[tool result ERROR] boom');
  assert.ok(renderRecord({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }, 500).text.length < 600);
});

test('readTranscript keeps the newest turns plus the opening task inside the byte budget', async () => {
  const lines = [user('THE ORIGINAL TASK'), ...Array.from({ length: 60 }, (_, i) => assistant([{ type: 'text', text: `turn ${i} ${'p'.repeat(200)}` }]))];
  await withHome(lines, async ({ path }) => {
    const r = await readTranscript(path, { maxBytes: 2048, maxTurns: 40, maxItemBytes: 2000 });
    assert.ok(r.bytes <= 2048, `bytes ${r.bytes}`);
    assert.match(r.excerpt, /^session start \(user\): THE ORIGINAL TASK/);
    assert.match(r.excerpt, /turn 59/);
    assert.ok(!r.excerpt.includes('turn 5 '), 'old turns are dropped first');
    assert.ok(r.dropped_older_turns > 0);
    // maxTurns caps the window even when the byte budget is generous.
    const few = await readTranscript(path, { maxBytes: 131072, maxTurns: 3, maxItemBytes: 2000 });
    assert.equal(few.turns, 4); // 3 recent + the opening task
    // A budget below the floor produces nothing rather than a useless fragment.
    assert.equal(await readTranscript(path, { maxBytes: 8, maxTurns: 40, maxItemBytes: 2000 }), undefined);
    assert.equal(await readTranscript(join(path, 'missing'), {}), undefined);
  });
});

test('readTranscript reads a window off a large file and says what it never read', async () => {
  const filler = Array.from({ length: 4000 }, (_, i) => assistant([{ type: 'text', text: `old ${i} ${'q'.repeat(400)}` }]));
  await withHome([user('FIRST TASK'), ...filler, assistant([{ type: 'text', text: 'NEWEST TURN' }])], async ({ path }) => {
    const r = await readTranscript(path, { maxBytes: 4096, maxTurns: 40, maxItemBytes: 2000 });
    assert.match(r.excerpt, /NEWEST TURN/);
    assert.match(r.excerpt, /^session start \(user\): FIRST TASK/);
    assert.ok(r.bytes <= 4096);
    // The middle of the file is outside the read window, so it cannot be counted -- only declared.
    assert.equal(r.earlier_turns_not_read, true);
    assert.match(r.excerpt, /earlier turns not read/);
  });
  // A file that fits entirely in the window makes no such claim.
  await withHome([user('SMALL TASK'), assistant([{ type: 'text', text: 'done' }])], async ({ path }) => {
    const r = await readTranscript(path, { maxBytes: 4096, maxTurns: 40, maxItemBytes: 2000 });
    assert.equal(r.earlier_turns_not_read, false);
    assert.ok(!r.excerpt.includes('earlier turns not read'));
  });
});

test('a long tool_use argument is clipped harder than the result underneath it', () => {
  const rendered = renderRecord({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(8000) } },
  ] } }, 2000);
  // maxItemBytes/TOOL_INPUT_SHARE, so the arguments cannot consume the whole per-turn budget.
  assert.ok(Buffer.byteLength(rendered.text, 'utf8') < 700, rendered.text.length);
  assert.match(rendered.text, /^\[tool Bash\]/);
  assert.match(rendered.text, /clipped/);
});

// --- integration through a real consultation -------------------------------------------------
async function httpFixture(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { await fn(`http://127.0.0.1:${server.address().port}/v1/chat/completions`); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'advice' } }] });
const configFor = (endpoint, transcript, profileExtra = {}, limits = {}) => validateConfig({
  version: 1, defaultProfile: 'a', limits, ...(transcript ? { transcript } : {}),
  profiles: { a: { kind: 'chat-completions', model: 'm', enabled: true, endpoint, allowInsecureLoopback: true, ...profileExtra } },
});

test('the session transcript is off by default, opt-out per call and per profile, and never leaks a key', async () => {
  const lines = [user('BUILD THE THING'), assistant([{ type: 'text', text: 'my api key is sk-abcdefghijklmnopqrstuvwxyz012345' }])];
  await withHome(lines, async ({ env }) => {
    let body;
    await httpFixture((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => { body = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); });
    }, async endpoint => {
      const payload = () => JSON.parse(body.messages.at(-1).content);
      const ask = (cfg, input = {}) => createAdvisor(cfg, { env }).consult({ question: 'Q', ...input });

      // Default: no transcript block in the config means nothing is read or sent.
      const off = await ask(configFor(endpoint));
      assert.equal(off.transcript_turns, 0);
      assert.equal(off.evidence_scope, 'provided-context-only');
      assert.equal(payload().session_transcript, undefined);
      assert.equal(createAdvisor(configFor(endpoint), { env }).list().session_transcript_enabled, false);

      // Enabled: the excerpt rides along, and the credential in it is blanked out.
      const on = await ask(configFor(endpoint, { enabled: true, maxBytes: 8192 }));
      assert.equal(on.evidence_scope, 'provided-context-and-session-transcript');
      assert.ok(on.transcript_turns >= 1);
      const sent = payload().session_transcript;
      assert.equal(sent.partial, true);
      assert.match(sent.text, /BUILD THE THING/);
      assert.ok(!sent.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
      assert.match(sent.text, /\[redacted\]/);

      // Opt-outs: per call, and per profile via transcriptMaxBytes 0.
      assert.equal((await ask(configFor(endpoint, { enabled: true }), { include_transcript: false })).transcript_turns, 0);
      assert.equal(payload().session_transcript, undefined);
      assert.equal((await ask(configFor(endpoint, { enabled: true }, { transcriptMaxBytes: 0 }))).transcript_turns, 0);
      assert.equal(payload().session_transcript, undefined);

      // A request budget with no room left simply ships without the transcript.
      const tight = await ask(configFor(endpoint, { enabled: true }, {}, { maxRequestBytes: 1500 }));
      assert.equal(tight.transcript_turns, 0);
      assert.equal(payload().session_transcript, undefined);
    });
  });
});

test('transcript configuration is range-checked', () => {
  const base = { version: 1, defaultProfile: 'a', profiles: { a: { kind: 'chat-completions', model: 'm', enabled: true, endpoint: 'https://p.example/v1/chat/completions' } } };
  for (const bad of [{ maxBytes: 512 }, { maxBytes: 200000 }, { maxTurns: 0 }, { maxTurns: 201 }, { maxItemBytes: 10 }, { enabled: 'yes' }, { nope: 1 }]) {
    assert.throws(() => validateConfig({ ...base, transcript: { enabled: true, ...bad } }), isCode('CONFIG'));
  }
  for (const bad of [-1, 131073, 1.5]) {
    assert.throws(() => validateConfig({ ...base, profiles: { a: { ...base.profiles.a, transcriptMaxBytes: bad } } }), isCode('CONFIG'));
  }
  assert.equal(validateConfig({ ...base, transcript: { enabled: true } }).transcript.maxBytes, TRANSCRIPT_DEFAULTS.maxBytes);
});
