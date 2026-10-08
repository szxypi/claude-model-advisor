import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig, loadConfig, normalizeInput, createAdvisor, guardSecrets, publicError, defaultHistoryPath, waitForEndpoint } from '../src/core.mjs';
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
  for (const timeoutMs of [NaN, -1, 0, 999, 600001, 1.5]) assert.throws(() => config('ok', { timeoutMs }), isCode('CONFIG'));
  // The overall deadline covers at least one attempt and stays below the host tool timeout.
  for (const totalTimeoutMs of [NaN, 1.5, 119999, 840001]) assert.throws(() => config('ok', { totalTimeoutMs }), isCode('CONFIG'));
  assert.throws(() => config('ok', { timeoutMs: 600000, totalTimeoutMs: 300000 }), isCode('CONFIG'));
  assert.equal(config('ok', { timeoutMs: 300000 }).limits.totalTimeoutMs, 840000);
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
test('answerWordBudget is range-checked and reaches both the directive line and the payload', async () => {
  const base = { kind: 'chat-completions', model: 'm', enabled: true, endpoint: 'https://p.example/v1/chat/completions' };
  for (const bad of [39, 2001, 400.5, '400', null]) {
    assert.throws(() => validateConfig({ version: 1, defaultProfile: 'a', profiles: { a: { ...base, answerWordBudget: bad } } }), isCode('CONFIG'));
  }
  let seen;
  await httpFixture((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion()));
    });
  }, async endpoint => {
    await createAdvisor(httpConfig(endpoint, { answerWordBudget: 400 })).consult(input);
    const user = seen.messages.at(-1);
    assert.equal(user.role, 'user');
    assert.match(user.content, /^\(Advisor: please keep your guidance under 400 words/);
    // The JSON evidence package follows the directive line and carries the budget for command adapters.
    assert.equal(JSON.parse(user.content.slice(user.content.indexOf('\n') + 1)).answer_word_budget, 400);
    // Unset means no directive line and no field at all.
    await createAdvisor(httpConfig(endpoint)).consult(input);
    const plain = seen.messages.at(-1).content;
    assert.ok(!plain.startsWith('(Advisor:'));
    assert.equal(JSON.parse(plain).answer_word_budget, undefined);
  });
});
const fallbackConfig = (primary, secondary, extra = {}, top = {}) => validateConfig({
  version: 1, defaultProfile: 'sol', ...top,
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
test('provider failure walks the fallback chain and is reported', async () => {
  let secondaryHits = 0;
  await httpFixture((req, res) => { res.statusCode = 500; res.end('{}'); }, async primary => {
    await httpFixture((req, res) => { secondaryHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('kimi advice'))); }, async secondary => {
      const r = await createAdvisor(fallbackConfig(primary, secondary)).consult(input);
      assert.equal(r.answer, 'kimi advice'); assert.equal(r.profile, 'kimi'); assert.equal(r.requested_model, 'kimi-id');
      assert.equal(r.fallback_from, 'sol'); assert.equal(r.fallback_reason, 'HTTP_OVERLOADED');
      assert.deepEqual(r.fallback_path, ['sol', 'kimi']); assert.equal(secondaryHits, 1);
      // Both profiles failing: kimi's fallback points back to sol, which is already visited, so the cycle stops.
      const dead = createAdvisor(fallbackConfig(primary, primary));
      await assert.rejects(dead.consult(input), isCode('HTTP_OVERLOADED'));
      assert.equal(dead.list().calls_remaining, 28);
    });
  });
});
test('primary timeout falls back within the overall deadline', async () => {
  let secondaryHits = 0;
  await httpFixture(() => {}, async primary => {
    await httpFixture((req, res) => { secondaryHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('kimi advice'))); }, async secondary => {
      const start = Date.now();
      const r = await createAdvisor(fallbackConfig(primary, secondary, {}, { limits: { timeoutMs: 1000, totalTimeoutMs: 5000 } })).consult(input);
      assert.equal(r.answer, 'kimi advice'); assert.equal(r.fallback_from, 'sol'); assert.equal(r.fallback_reason, 'TIMEOUT');
      assert.equal(secondaryHits, 1); assert.ok(Date.now() - start < 2500);
    });
  });
});
test('fallback is skipped when the overall deadline leaves too little time, and the skip is recorded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-deadline-'));
  const path = join(dir, 'history.jsonl');
  let secondaryHits = 0;
  try {
    await httpFixture(() => {}, async primary => {
      await httpFixture((req, res) => { secondaryHits++; res.end(JSON.stringify(completion())); }, async secondary => {
        const start = Date.now();
        const e = createAdvisor(fallbackConfig(primary, secondary, {}, { limits: { timeoutMs: 1000, totalTimeoutMs: 1500 }, history: { enabled: true, path } }));
        await assert.rejects(e.consult(input), isCode('TIMEOUT'));
        assert.equal(secondaryHits, 0); assert.ok(Date.now() - start < 2500);
        const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
        assert.equal(lines.length, 2);
        assert.equal(lines[0].profile, 'sol'); assert.equal(lines[0].error_code, 'TIMEOUT'); assert.equal(lines[0].fallback_from, undefined);
        assert.equal(lines[1].profile, 'kimi'); assert.equal(lines[1].error_code, 'TIMEOUT');
        assert.equal(lines[1].fallback_from, 'sol'); assert.equal(lines[1].fallback_skipped, 'DEADLINE');
      });
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a three-hop chain survives 500 then 400-unknown-provider and reports the original reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-chain-'));
  const path = join(dir, 'history.jsonl');
  let solHits = 0, astraHits = 0, kimiHits = 0;
  try {
    await httpFixture((req, res) => { solHits++; res.statusCode = 500; res.end('{}'); }, async sol => {
      // A disabled provider on the gateway (CPA) answers 400 "unknown provider for model".
      await httpFixture((req, res) => { astraHits++; res.writeHead(400); res.end(JSON.stringify({ error: { message: 'unknown provider for model gpt-6-astra' } })); }, async astra => {
        await httpFixture((req, res) => { kimiHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('kimi advice'))); }, async kimi => {
          const cfg = validateConfig({ version: 1, defaultProfile: 'sol', history: { enabled: true, path }, profiles: {
            sol: { kind: 'chat-completions', model: 'sol-id', enabled: true, endpoint: sol, allowInsecureLoopback: true, fallbackProfile: 'astra' },
            astra: { kind: 'chat-completions', model: 'astra-id', enabled: true, endpoint: astra, allowInsecureLoopback: true, fallbackProfile: 'kimi' },
            kimi: { kind: 'chat-completions', model: 'kimi-id', enabled: true, endpoint: kimi, allowInsecureLoopback: true },
          } });
          const r = await createAdvisor(cfg).consult(input);
          assert.equal(r.answer, 'kimi advice'); assert.equal(r.profile, 'kimi');
          // The result keeps the ORIGINAL failure attribution even though the middle hop failed differently.
          assert.equal(r.fallback_from, 'sol'); assert.equal(r.fallback_reason, 'HTTP_OVERLOADED');
          assert.deepEqual(r.fallback_path, ['sol', 'astra', 'kimi']);
          assert.equal(solHits, 1); assert.equal(astraHits, 1); assert.equal(kimiHits, 1);
          const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
          assert.equal(lines.length, 3);
          assert.equal(lines[0].ok, false); assert.equal(lines[0].profile, 'sol'); assert.equal(lines[0].error_code, 'HTTP_OVERLOADED');
          assert.equal(lines[0].fallback_from, undefined);
          assert.equal(lines[1].ok, false); assert.equal(lines[1].profile, 'astra'); assert.equal(lines[1].error_code, 'HTTP_PROVIDER');
          assert.equal(lines[1].fallback_from, 'sol'); assert.equal(lines[1].fallback_reason, 'HTTP_OVERLOADED');
          assert.equal(lines[2].ok, true); assert.equal(lines[2].profile, 'kimi');
          assert.equal(lines[2].fallback_from, 'sol'); assert.equal(lines[2].fallback_reason, 'HTTP_OVERLOADED');
          assert.deepEqual(lines[2].fallback_path, ['sol', 'astra', 'kimi']);
        });
      });
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('fallback chains stop at an already visited profile instead of looping', async () => {
  let aHits = 0, bHits = 0;
  await httpFixture((req, res) => { aHits++; res.statusCode = 500; res.end('{}'); }, async a => {
    await httpFixture((req, res) => { bHits++; res.statusCode = 500; res.end('{}'); }, async b => {
      const cfg = validateConfig({ version: 1, defaultProfile: 'a', profiles: {
        a: { kind: 'chat-completions', model: 'a-id', enabled: true, endpoint: a, allowInsecureLoopback: true, fallbackProfile: 'b' },
        b: { kind: 'chat-completions', model: 'b-id', enabled: true, endpoint: b, allowInsecureLoopback: true, fallbackProfile: 'a' },
      } });
      await assert.rejects(createAdvisor(cfg).consult(input), isCode('HTTP_OVERLOADED'));
      assert.equal(aHits, 1); assert.equal(bHits, 1);
    });
  });
});
test('a mid-chain hop that eats the deadline stops the chain before the next hop', async () => {
  let kimiHits = 0;
  await httpFixture((req, res) => { res.statusCode = 500; res.end('{}'); }, async sol => {
    await httpFixture(() => {}, async astra => {
      await httpFixture((req, res) => { kimiHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); }, async kimi => {
        const cfg = validateConfig({ version: 1, defaultProfile: 'sol', limits: { timeoutMs: 1000, totalTimeoutMs: 1800 }, profiles: {
          sol: { kind: 'chat-completions', model: 's', enabled: true, endpoint: sol, allowInsecureLoopback: true, fallbackProfile: 'astra' },
          astra: { kind: 'chat-completions', model: 'as', enabled: true, endpoint: astra, allowInsecureLoopback: true, fallbackProfile: 'kimi' },
          kimi: { kind: 'chat-completions', model: 'k', enabled: true, endpoint: kimi, allowInsecureLoopback: true },
        } });
        const start = Date.now();
        await assert.rejects(createAdvisor(cfg).consult(input), isCode('TIMEOUT'));
        assert.equal(kimiHits, 0); assert.ok(Date.now() - start < 2500);
      });
    });
  });
});
test('fallback is not used for input, secret, budget or disabled-profile errors', async () => {  let hits = 0;
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
// A loopback port with nothing listening on it, so every connection to it is refused.
async function closedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
const loopback = port => `http://127.0.0.1:${port}/v1/chat/completions`;
const ledger = async path => (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
// Ref'ed timers and sockets only: any of these left behind keeps the test process alive.
const liveHandles = () => process.getActiveResourcesInfo().filter(r => ['Timeout', 'TCPSocketWrap', 'ConnectWrap'].includes(r)).length;
test('after a NETWORK failure the next hop waits for its endpoint to accept TCP, then succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-netwait-'));
  const path = join(dir, 'history.jsonl');
  // Both hops share one gateway endpoint, as in a CPA restart. It refuses connections for about 2 s.
  const port = await closedPort();
  let hits = 0;
  const server = createServer((req, res) => { hits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('kimi advice'))); });
  const reopen = setTimeout(() => server.listen(port, '127.0.0.1'), 2000);
  try {
    const r = await createAdvisor(fallbackConfig(loopback(port), loopback(port), {}, { history: { enabled: true, path } })).consult(input);
    assert.equal(r.answer, 'kimi advice'); assert.equal(r.profile, 'kimi');
    assert.equal(r.fallback_from, 'sol'); assert.equal(r.fallback_reason, 'NETWORK');
    assert.deepEqual(r.fallback_path, ['sol', 'kimi']); assert.equal(hits, 1);
    const lines = await ledger(path);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].profile, 'sol'); assert.equal(lines[0].error_code, 'NETWORK'); assert.equal(lines[0].network_wait_ms, undefined);
    assert.equal(lines[1].ok, true); assert.equal(lines[1].profile, 'kimi'); assert.deepEqual(lines[1].fallback_path, ['sol', 'kimi']);
    const waited = lines[1].network_wait_ms;
    assert.ok(Number.isInteger(waited) && waited >= 1500 && waited < 10000, `network_wait_ms=${waited}`);
  } finally {
    clearTimeout(reopen);
    await new Promise(resolve => { if (!server.listening) { resolve(); return; } server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
test('an endpoint that stays down is waited for only until the deadline minus the fallback reserve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-netwait-deadline-'));
  const down = loopback(await closedPort());
  try {
    // 32500 ms overall minus the 30000 ms fallback reserve leaves about 2.5 s for the wait, far below 60 s.
    // timeoutMs 1000 keeps the per-hop floor below the reserve, so the hop is still sent after the wait.
    const sent = join(dir, 'sent.jsonl');
    const start = Date.now();
    await assert.rejects(createAdvisor(fallbackConfig(down, down, {}, { limits: { timeoutMs: 1000, totalTimeoutMs: 32500 }, history: { enabled: true, path: sent } })).consult(input), isCode('NETWORK'));
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 2000 && elapsed < 5000, `elapsed=${elapsed}`);
    let lines = await ledger(sent);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].profile, 'kimi'); assert.equal(lines[1].error_code, 'NETWORK'); assert.equal(lines[1].fallback_skipped, undefined);
    assert.ok(Number.isInteger(lines[1].network_wait_ms) && lines[1].network_wait_ms >= 2000 && lines[1].network_wait_ms < 3000, `network_wait_ms=${lines[1].network_wait_ms}`);
    // With timeoutMs above the reserve, the wait leaves a budget of 30000 ms or a few ms less. The existing
    // DEADLINE check then skips the hop, except on an exact-millisecond tie, where it sends the hop.
    // Either way the hop record carries network_wait_ms and the chain ends with NETWORK.
    const skipped = join(dir, 'skipped.jsonl');
    await assert.rejects(createAdvisor(fallbackConfig(down, down, {}, { limits: { timeoutMs: 31000, totalTimeoutMs: 32500 }, history: { enabled: true, path: skipped } })).consult(input), isCode('NETWORK'));
    lines = await ledger(skipped);
    assert.equal(lines.length, 2); assert.equal(lines[1].profile, 'kimi'); assert.equal(lines[1].error_code, 'NETWORK');
    assert.ok(lines[1].network_wait_ms >= 2000 && lines[1].network_wait_ms < 3000, `network_wait_ms=${lines[1].network_wait_ms}`);
    assert.ok([undefined, 'DEADLINE'].includes(lines[1].fallback_skipped));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cancellation or shutdown during the NETWORK wait ends it at once and leaves no timer or socket behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-netwait-abort-'));
  const path = join(dir, 'history.jsonl');
  const down = loopback(await closedPort());
  try {
    const before = liveHandles();
    const e = createAdvisor(fallbackConfig(down, down, {}, { history: { enabled: true, path } }));
    const ac = new AbortController();
    const pending = e.consult(input, { signal: ac.signal });
    const checked = assert.rejects(pending, isCode('CANCELLED'));
    await delay(300);
    // The wait keeps the consultation's concurrency slot, as a running hop does.
    await assert.rejects(e.consult(input), isCode('BUSY'));
    let at = Date.now();
    ac.abort();
    await checked;
    assert.ok(Date.now() - at < 1000);
    const hop = (await ledger(path)).find(l => l.profile === 'kimi');
    assert.equal(hop.error_code, 'CANCELLED'); assert.equal(hop.fallback_reason, 'NETWORK');
    assert.ok(Number.isInteger(hop.network_wait_ms) && hop.network_wait_ms >= 200 && hop.network_wait_ms < 1500, `network_wait_ms=${hop.network_wait_ms}`);
    // close() reaches a wait in progress the same way it reaches a running adapter.
    const s = createAdvisor(fallbackConfig(down, down));
    const stopped = assert.rejects(s.consult(input), isCode('SHUTDOWN'));
    await delay(300);
    at = Date.now();
    s.close();
    await stopped;
    assert.ok(Date.now() - at < 1000);
    // An abort while a probe socket is still connecting also cleans up.
    const probe = new AbortController();
    const waiting = waitForEndpoint(down, probe.signal, 60000);
    probe.abort();
    const result = await waiting;
    assert.equal(result.connected, false); assert.ok(result.waitedMs < 100);
    await delay(50);
    assert.ok(liveHandles() <= before, JSON.stringify(process.getActiveResourcesInfo()));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('no wait unless the failure is NETWORK and the next hop has an endpoint, as in 0.9.0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-netwait-none-'));
  const down = loopback(await closedPort());
  try {
    // HTTP_OVERLOADED, then an unreachable next hop: a wait would hold the chain for 60 s.
    const overloaded = join(dir, 'overloaded.jsonl');
    await httpFixture((req, res) => { res.statusCode = 500; res.end('{}'); }, async primary => {
      const start = Date.now();
      await assert.rejects(createAdvisor(fallbackConfig(primary, down, {}, { history: { enabled: true, path: overloaded } })).consult(input), isCode('NETWORK'));
      assert.ok(Date.now() - start < 1000);
    });
    let lines = await ledger(overloaded);
    assert.equal(lines.length, 2); assert.equal(lines[0].error_code, 'HTTP_OVERLOADED');
    assert.equal(lines[1].profile, 'kimi'); assert.equal(lines[1].fallback_reason, 'HTTP_OVERLOADED'); assert.equal(lines[1].error_code, 'NETWORK');
    assert.ok(!('network_wait_ms' in lines[1]));
    // NETWORK, then a command profile: it has no endpoint, so it runs at once.
    const command = join(dir, 'command.jsonl');
    const cfg = validateConfig({ version: 1, defaultProfile: 'sol', history: { enabled: true, path: command }, profiles: {
      sol: { kind: 'chat-completions', model: 'sol-id', enabled: true, endpoint: down, allowInsecureLoopback: true, fallbackProfile: 'local' },
      local: { kind: 'command', model: 'local-id', enabled: true, command: process.execPath, args: [fixture, 'ok'] },
    } });
    const r = await createAdvisor(cfg).consult(input);
    assert.equal(r.profile, 'local'); assert.equal(r.fallback_reason, 'NETWORK'); assert.deepEqual(r.fallback_path, ['sol', 'local']);
    lines = await ledger(command);
    assert.equal(lines.length, 2); assert.equal(lines[1].ok, true); assert.ok(!('network_wait_ms' in lines[1]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('history is off by default, validated, and platform-aware', () => {
  assert.equal(config().history.enabled, false);
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'sol', profiles: {}, history: { enabled: 'yes' } }), isCode('CONFIG'));
  assert.throws(() => validateConfig({ version: 1, defaultProfile: 'sol', profiles: {}, history: { path: 'relative.jsonl' } }), isCode('CONFIG'));
  assert.match(defaultHistoryPath({ XDG_STATE_HOME: '/x' }, 'linux'), /^\/x\/model-advisor\/history\.jsonl$/);
  assert.match(defaultHistoryPath({ LOCALAPPDATA: 'C:\\L' }, 'win32'), /model-advisor/);
});
test('history ledger records success, failure and fallback without leaking secrets, and never breaks a consultation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-hist-'));
  const path = join(dir, 'nested', 'history.jsonl');
  try {
    let fail500 = true;
    await httpFixture((req, res) => {
      if (fail500) { res.statusCode = 500; res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('ledger advice')));
    }, async endpoint => {
      const make = (extra) => validateConfig({ version: 1, defaultProfile: 'sol', history: { enabled: true, ...extra }, profiles: {
        sol: { kind: 'chat-completions', model: 'sol-id', enabled: true, endpoint, allowInsecureLoopback: true, apiKeyEnv: 'HK', fallbackProfile: 'kimi' },
        kimi: { kind: 'chat-completions', model: 'kimi-id', enabled: true, endpoint, allowInsecureLoopback: true },
      } });
      const env = { HK: 'ledger-secret-key-123' };
      // primary 500 -> fallback also 500 -> one failure record per attempted profile
      await assert.rejects(createAdvisor(make({ path }), { env }).consult(input), isCode('HTTP_OVERLOADED'));
      fail500 = false;
      const r = await createAdvisor(make({ path, storeAnswer: false }), { env }).consult({ question: 'Q2', context: [{ label: 'L1', text: 'evidence' }] });
      assert.equal(r.answer, 'ledger advice');
      const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines.length, 3);
      assert.equal(lines[0].ok, false); assert.equal(lines[0].profile, 'sol'); assert.equal(lines[0].error_code, 'HTTP_OVERLOADED');
      assert.equal(lines[0].fallback_from, undefined);
      assert.equal(lines[1].ok, false); assert.equal(lines[1].fallback_from, 'sol'); assert.equal(lines[1].profile, 'kimi'); assert.equal(lines[1].error_code, 'HTTP_OVERLOADED');
      assert.equal(lines[2].ok, true); assert.equal(lines[2].question, 'Q2'); assert.deepEqual(lines[2].context_labels, ['L1']);
      assert.equal(lines[2].answer, undefined); assert.equal(lines[2].answer_bytes, 13);
      assert.ok(!(await readFile(path, 'utf8')).includes('ledger-secret-key-123'));
      // unwritable history path (parent is a regular file) does not break the consultation
      await writeFile(join(dir, 'blocker'), 'x');
      assert.equal((await createAdvisor(make({ path: join(dir, 'blocker', 'history.jsonl') }), { env }).consult(input)).answer, 'ledger advice');
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
for (const [status, code] of [[401, 'HTTP_AUTH'], [403, 'HTTP_AUTH'], [429, 'HTTP_RATE'],
  [400, 'HTTP_ERROR'], [500, 'HTTP_OVERLOADED'], [503, 'HTTP_OVERLOADED']]) {
  test(`HTTP ${status} returns sanitized ${code} without retries`, async () => {
    let hits = 0;
    await httpFixture((req, res) => { hits++; res.writeHead(status); res.end('do-not-echo-this-provider-secret'); }, async endpoint => {
      await assert.rejects(createAdvisor(httpConfig(endpoint)).consult(input), e => e.code === code && !e.message.includes('provider-secret'));
      assert.equal(hits, 1);
    });
  });
}
test('HTTP 400 with unknown provider for model is a provider failure that triggers fallback', async () => {
  let backupHits = 0;
  await httpFixture((req, res) => { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'unknown provider for model gpt-6-astra' } })); }, async primary => {
    // Without a fallback configured the new code is surfaced.
    await assert.rejects(createAdvisor(httpConfig(primary)).consult(input), isCode('HTTP_PROVIDER'));
    await httpFixture((req, res) => { backupHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion('backup advice'))); }, async secondary => {
      const cfg = validateConfig({ version: 1, defaultProfile: 'a', profiles: {
        a: { kind: 'chat-completions', model: 'a-id', enabled: true, endpoint: primary, allowInsecureLoopback: true, fallbackProfile: 'b' },
        b: { kind: 'chat-completions', model: 'b-id', enabled: true, endpoint: secondary, allowInsecureLoopback: true },
      } });
      const r = await createAdvisor(cfg).consult(input);
      assert.equal(r.answer, 'backup advice'); assert.equal(r.fallback_reason, 'HTTP_PROVIDER');
      assert.deepEqual(r.fallback_path, ['a', 'b']); assert.equal(backupHits, 1);
    });
  });
});
test('other HTTP 400 bodies stay HTTP_ERROR and never trigger a fallback', async () => {
  let backupHits = 0;
  await httpFixture((req, res) => { res.writeHead(400); res.end('{"error":"invalid request"}'); }, async primary => {
    await httpFixture((req, res) => { backupHits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); }, async secondary => {
      const cfg = validateConfig({ version: 1, defaultProfile: 'a', profiles: {
        a: { kind: 'chat-completions', model: 'a-id', enabled: true, endpoint: primary, allowInsecureLoopback: true, fallbackProfile: 'b' },
        b: { kind: 'chat-completions', model: 'b-id', enabled: true, endpoint: secondary, allowInsecureLoopback: true },
      } });
      await assert.rejects(createAdvisor(cfg).consult(input), isCode('HTTP_ERROR'));
      assert.equal(backupHits, 0);
    });
  });
});
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
