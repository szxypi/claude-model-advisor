import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig, loadConfig, normalizeInput, createAdvisor, guardSecrets, publicError } from '../src/core.mjs';
const fixture = fileURLToPath(new URL('./fixtures/adapter.mjs', import.meta.url));
const config = (mode = 'ok', limits = {}, extras = {}) => validateConfig({
  version: 1, defaultProfile: 'sol', limits,
  profiles: { sol: { kind: 'command', enabled: true, model: 'user-model-id', command: process.execPath, args: [fixture, mode], ...extras } },
});
const input = { question: 'What are the architectural risks?' };
const isCode = code => error => error?.code === code;
const query = (mode, limits, extras) => createAdvisor(config(mode, limits, extras)).consult(input);

test('configuration rejects unknown fields and invalid profile references', () => {
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'x', profiles: {}, typo: true }), isCode('CONFIG'));
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'x', profiles: {} }), isCode('CONFIG'));
});
test('configuration rejects invalid numeric limits and unsafe environment keys', () => {
  for (const timeoutMs of [NaN, -1, 0, 999, 180001, 1.5]) assert.throws(() => config('ok', { timeoutMs }), isCode('CONFIG'));
  for (const key of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'ADVISOR_CONFIG']) assert.throws(() => config('ok', {}, { envKeys: [key] }), isCode('CONFIG'));
});
test('command must be absolute or the explicit node alias', () => {
  assert.throws(() => config('ok', {}, { command: 'my-cli' }), isCode('CONFIG'));
  assert.equal(config('ok', {}, { command: 'node' }).profiles.get('sol').command, 'node');
});
test('configuration loading has explicit file errors', async () => {
  await assert.rejects(loadConfig('/nonexistent/model-advisor-config.json'), isCode('CONFIG_READ'));
  await assert.rejects(loadConfig('relative.json'), isCode('CONFIG'));
  const dir = await mkdtemp(join(tmpdir(), 'advisor-test-'));
  try {
    const file = join(dir, 'bad.json'); await writeFile(file, '{invalid');
    await assert.rejects(loadConfig(file), isCode('CONFIG_READ'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('input rejects command injection fields instead of accepting executable parameters', () => {
  for (const field of ['command', 'endpoint', 'project_dir', 'include_git_diff']) assert.throws(() => normalizeInput({ ...input, [field]: 'x' }), isCode('INPUT'));
  assert.equal(normalizeInput({ ...input, context: [{ label: 'excerpt', text: 'code' }] }).context[0].partial, true);
});
test('credential guard catches known values and private keys without echoing them', () => {
  assert.throws(() => guardSecrets('here is my-test-secret-123', ['my-test-secret-123']), isCode('SENSITIVE_INPUT'));
  assert.throws(() => guardSecrets('-----BEGIN RSA PRIVATE KEY-----'), isCode('SENSITIVE_INPUT'));
  const e = publicError(new Error('do not leak my-test-secret-123'));
  assert.equal(e.error.code, 'INTERNAL'); assert.ok(!JSON.stringify(e).includes('my-test-secret-123'));
});
test('command adapter returns normalized untrusted advice', async () => {
  const r = await query('ok'); assert.equal(r.ok, true); assert.equal(r.untrusted, true);
  assert.equal(r.requested_model, 'user-model-id'); assert.equal(r.evidence_scope, 'provided-context-only');
});
for (const [mode, code] of [['bad-json', 'BAD_RESPONSE'], ['empty', 'BAD_RESPONSE'], ['wrong-id', 'BAD_RESPONSE'], ['controls', 'BAD_RESPONSE'], ['oversize', 'OUTPUT_LIMIT'], ['stderr-limit', 'OUTPUT_LIMIT'], ['exit', 'ADAPTER_EXIT']]) {
  test(`command failure ${mode} is bounded and sanitized`, async () => {
    await assert.rejects(query(mode), e => e.code === code && !e.message.includes('raw-secret'));
  });
}
test('missing executable and early stdin closure do not crash the server', async () => {
  await assert.rejects(query('ok', {}, { command: '/nonexistent/executable' }), isCode('ADAPTER_START'));
  await assert.rejects(query('early-exit'), e => ['ADAPTER_EXIT', 'ADAPTER_IO'].includes(e.code));
});
test('command environment is allowlisted and working directory is removed', async () => {
  const engine = createAdvisor(config('env', {}, { envKeys: ['PRIVATE_API_KEY'] }), { env: { PARENT_SECRET: 'parent-only', PRIVATE_API_KEY: 'private-value-123' } });
  const r = JSON.parse((await engine.consult(input)).answer);
  assert.equal(r.inheritedSecret, false); assert.equal(r.allowedPresent, true);
  assert.equal(r.recursion, '1'); assert.equal(r.cwd, r.home);
  await assert.rejects(access(r.cwd));
});
test('credential echo in output is withheld', async () => {
  const engine = createAdvisor(config('secret-output', {}, { envKeys: ['PRIVATE_API_KEY'] }), { env: { PRIVATE_API_KEY: 'private-value-123' } });
  await assert.rejects(engine.consult(input), isCode('SENSITIVE_OUTPUT'));
});
test('configured secret belonging to another profile is also blocked', async () => {
  const raw = { version: 1, defaultProfile: 'a', profiles: {
    a: { kind: 'command', command: 'node', args: [fixture, 'ok'], model: 'one', enabled: true },
    b: { kind: 'chat-completions', endpoint: 'https://provider.example/v1/chat/completions', apiKeyEnv: 'OTHER_KEY', model: 'two' },
  } };
  const e = createAdvisor(validateConfig(raw), { env: { OTHER_KEY: 'other-profile-secret' } });
  await assert.rejects(e.consult({ question: 'do not send other-profile-secret' }), isCode('SENSITIVE_INPUT'));
});
test('input size limits count UTF-8 bytes, not JavaScript characters', async () => {
  const e = createAdvisor(config('ok', { maxRequestBytes: 2048 }));
  await assert.rejects(e.consult({ question: '汉'.repeat(1000) }), isCode('INPUT_TOO_LARGE'));
});
test('unknown and disabled profiles do not dispatch', async () => {
  await assert.rejects(createAdvisor(config()).consult({ ...input, profile: 'missing' }), isCode('PROFILE'));
  await assert.rejects(createAdvisor(config('ok', {}, { enabled: false })).consult(input), isCode('DISABLED'));
});
test('concurrency and process-budget guards are enforced', async () => {
  const e = createAdvisor(config('slow', { maxCallsPerProcess: 1 }));
  const pending = e.consult(input);
  await assert.rejects(e.consult(input), isCode('BUSY'));
  await pending;
  await assert.rejects(e.consult(input), isCode('BUDGET'));
  assert.equal(e.list().calls_remaining, 0);
});
test('already cancelled consultations do not spend the process budget', async () => {
  const ac = new AbortController(); ac.abort(); const e = createAdvisor(config());
  await assert.rejects(e.consult(input, { signal: ac.signal }), isCode('CANCELLED'));
  assert.equal(e.list().calls_remaining, 30);
});
test('cancellation and shutdown propagate to an active command', async () => {
  const e = createAdvisor(config('hang')); const ac = new AbortController();
  const p = e.consult(input, { signal: ac.signal });
  const checked = assert.rejects(p, isCode('CANCELLED')); setTimeout(() => ac.abort(), 150); await checked;
  const q = e.consult(input); const stopped = assert.rejects(q, isCode('SHUTDOWN'));
  setTimeout(() => e.close(), 150); await stopped;
  await assert.rejects(e.consult(input), isCode('SHUTDOWN'));
});
test('recursion marker prevents nested engine startup', () => {
  assert.throws(() => createAdvisor(config(), { env: { ADVISOR_DEPTH: '1' } }), isCode('RECURSION'));
});
async function processRunning(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const s = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (s.slice(s.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch { return false; }
}
for (const mode of ['ignore-term', 'descendant']) {
  test(`deadline forcibly terminates ${mode} process group`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'advisor-process-test-'));
    try {
      const pidfile = join(dir, 'pid');
      const started = Date.now();
      await assert.rejects(query(mode, { timeoutMs: 1000 }, { args: [fixture, mode, pidfile] }), isCode('TIMEOUT'));
      assert.ok(Date.now() - started < 4500);
      const pid = Number(await readFile(pidfile, 'utf8'));
      for (let i = 0; i < 30 && await processRunning(pid); i++) await delay(50);
      assert.equal(await processRunning(pid), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

async function httpFixture(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  try { await fn(endpoint); } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
const httpConfig = (endpoint, extra = {}, limits = {}) => validateConfig({
  version: 1, defaultProfile: 'local', limits,
  profiles: { local: { kind: 'chat-completions', model: 'third-party-id', enabled: true, endpoint, allowInsecureLoopback: true, ...extra } },
});
const completion = (content = 'HTTP fixture advice', reason = 'stop') => ({ choices: [{ finish_reason: reason, message: { role: 'assistant', content } }] });

test('HTTP configuration rejects insecure remote endpoints and inline credentials', () => {
  for (const url of ['http://provider.example/chat', 'https://user:pass@provider.example/chat', 'https://provider.example/chat?key=secret']) assert.throws(() => httpConfig(url), isCode('CONFIG'));
});
test('HTTP adapter sends the configured model, correct auth, explicit evidence and no tools', async () => {
  await httpFixture(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    assert.equal(req.headers.authorization, 'Bearer test-provider-key-123');
    assert.equal(parsed.model, 'third-party-id'); assert.equal(parsed.stream, false);
    assert.equal(parsed.messages[0].role, 'developer'); assert.equal(parsed.max_completion_tokens, 2048);
    assert.equal(parsed.tools, undefined); assert.ok(!body.includes('test-provider-key-123'));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion()));
  }, async endpoint => {
    const e = createAdvisor(httpConfig(endpoint, { apiKeyEnv: 'TEST_KEY', systemRole: 'developer', tokenLimit: { field: 'max_completion_tokens', value: 2048 } }), { env: { TEST_KEY: 'test-provider-key-123' } });
    assert.equal((await e.consult(input)).answer, 'HTTP fixture advice');
  });
});
test('HTTP extraBody passes provider fields through but cannot override protocol fields', async () => {
  for (const extraBody of [{ model: 'x' }, { messages: [] }, { stream: true }, { tools: [] }, { 'Bad-Key': 1 }, [], 'x', { fn() {} }])
    assert.throws(() => httpConfig('https://provider.example/v1/chat/completions', { extraBody }), isCode('CONFIG'));
  assert.throws(() => httpConfig('https://provider.example/v1/chat/completions', { extraBody: { max_tokens: 1 }, tokenLimit: { field: 'max_tokens', value: 2 } }), isCode('CONFIG'));
  await httpFixture(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    assert.equal(parsed.reasoning_effort, 'xhigh'); assert.equal(parsed.temperature, 0.2);
    assert.equal(parsed.model, 'third-party-id'); assert.equal(parsed.stream, false);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion()));
  }, async endpoint => {
    const e = createAdvisor(httpConfig(endpoint, { extraBody: { reasoning_effort: 'xhigh', temperature: 0.2 } }));
    assert.equal((await e.consult(input)).answer, 'HTTP fixture advice');
  });
});
const fallbackConfig = (primary, secondary, extra = {}) => validateConfig({
  version: 1, defaultProfile: 'sol',
  profiles: {
    sol: { kind: 'chat-completions', model: 'sol-id', enabled: true, endpoint: primary, allowInsecureLoopback: true, fallbackProfile: 'kimi', ...extra },
    kimi: { kind: 'chat-completions', model: 'kimi-id', enabled: true, endpoint: secondary, allowInsecureLoopback: true, fallbackProfile: 'sol' },
  },
});
test('fallbackProfile must reference another existing profile', () => {
  const base = { kind: 'chat-completions', model: 'm', enabled: true, endpoint: 'https://p.example/v1/chat/completions' };
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'a', profiles: { a: { ...base, fallbackProfile: 'zzz' } } }), isCode('CONFIG'));
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'a', profiles: { a: { ...base, fallbackProfile: 'a' } } }), isCode('CONFIG'));
  const ok = validateConfig({ version: 1, defaultProfile: 'a', profiles: { a: { ...base, fallbackProfile: 'b' }, b: base } });
  assert.equal(createAdvisor(ok).list().profiles[0].fallback_profile, 'b');
});
test('provider failure falls back exactly one hop and is reported', async () => {
  let secondaryHits = 0;
  await httpFixture((req, res) => { res.statusCode = 500; res.end('{}'); }, async primary => {
    await httpFixture((req, res) => { secondaryHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('kimi advice'))); }, async secondary => {
      const r = await createAdvisor(fallbackConfig(primary, secondary)).consult(input);
      assert.equal(r.answer, 'kimi advice'); assert.equal(r.profile, 'kimi'); assert.equal(r.requested_model, 'kimi-id');
      assert.equal(r.fallback_from, 'sol'); assert.equal(r.fallback_reason, 'HTTP_ERROR'); assert.equal(secondaryHits, 1);
      // Both profiles failing: the secondary's own fallback (sol) is not chained.
      const dead = createAdvisor(fallbackConfig(primary, primary));
      await assert.rejects(dead.consult(input), isCode('HTTP_ERROR'));
      assert.equal(dead.list().calls_remaining, 28);
    });
  });
});
test('fallback is not used for input, secret, budget or disabled-profile errors', async () => {
  let hits = 0;
  await httpFixture((req, res) => { hits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); }, async secondary => {
    const e = createAdvisor(fallbackConfig('https://primary.invalid/v1/chat/completions', secondary));
    await assert.rejects(e.consult({ question: 'token sk-abcdefghijklmnopqrstuvwxyz0123' }), isCode('SENSITIVE_INPUT'));
    await assert.rejects(e.consult({ question: 'x', bogus: 1 }), isCode('INPUT'));
    assert.equal(hits, 0);
    const disabled = validateConfig({ version: 1, defaultProfile: 'sol', profiles: {
      sol: { kind: 'chat-completions', model: 'a', enabled: true, endpoint: 'http://127.0.0.1:9/v1/chat/completions', allowInsecureLoopback: true, fallbackProfile: 'kimi' },
      kimi: { kind: 'chat-completions', model: 'b', enabled: false, endpoint: secondary, allowInsecureLoopback: true },
    } });
    await assert.rejects(createAdvisor(disabled).consult(input), isCode('NETWORK'));
    assert.equal(hits, 0);
  });
});
for (const [status, code] of [[401, 'HTTP_AUTH'], [403, 'HTTP_AUTH'], [429, 'HTTP_RATE'], [500, 'HTTP_ERROR']]) {
  test(`HTTP ${status} returns sanitized ${code} without retries`, async () => {
    let hits = 0;
    await httpFixture((req, res) => { hits++; res.writeHead(status); res.end('do-not-echo-this-provider-secret'); }, async endpoint => {
      await assert.rejects(createAdvisor(httpConfig(endpoint)).consult(input), e => e.code === code && !e.message.includes('provider-secret'));
      assert.equal(hits, 1);
    });
  });
}
test('HTTP redirects are not followed', async () => {
  let hits = 0;
  await httpFixture((req, res) => { hits++; res.writeHead(302, { Location: '/another-endpoint' }); res.end(); }, async endpoint => {
    await assert.rejects(createAdvisor(httpConfig(endpoint)).consult(input), isCode('NETWORK'));
    assert.equal(hits, 1);
  });
});
test('HTTP response byte limit prevents successful truncation', async () => {
  await httpFixture((req, res) => res.end('x'.repeat(5000)), async endpoint => {
    await assert.rejects(createAdvisor(httpConfig(endpoint, {}, { maxResponseBytes: 1024, maxAnswerBytes: 512 })).consult(input), isCode('OUTPUT_LIMIT'));
  });
});
for (const reason of ['length', 'tool_calls', 'content_filter']) {
  test(`HTTP finish_reason ${reason} is not reported as a completed review`, async () => {
    await httpFixture((req, res) => res.end(JSON.stringify(completion('partial answer', reason))), async endpoint => {
      await assert.rejects(createAdvisor(httpConfig(endpoint)).consult(input), isCode('INCOMPLETE'));
    });
  });
}
test('HTTP missing credentials fail before network dispatch', async () => {
  const e = createAdvisor(httpConfig('http://127.0.0.1:9/v1/chat/completions', { apiKeyEnv: 'MISSING_KEY' }), { env: {} });
  await assert.rejects(e.consult(input), isCode('AUTH'));
});
test('HTTP stalled response obeys the absolute deadline', async () => {
  await httpFixture(() => {}, async endpoint => {
    const start = Date.now();
    await assert.rejects(createAdvisor(httpConfig(endpoint, {}, { timeoutMs: 1000 })).consult(input), isCode('TIMEOUT'));
    assert.ok(Date.now() - start < 2500);
  });
});
