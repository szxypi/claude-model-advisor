// An actual stdio initialize -> tools/list -> tools/call smoke test.
// It requires the installed MCP SDK. It never contacts a real model.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'advisor-mcp-smoke-'));
const configPath = join(work, 'config.json');
await writeFile(configPath, JSON.stringify({
  version: 1, defaultProfile: 'mock',
  profiles: { mock: { kind: 'command', model: 'mock-only', enabled: true,
    command: process.execPath, args: [join(root, 'adapters', 'mock.mjs')] } },
}), { mode: 0o600 });
const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
  cwd: work, env: { ...process.env, ADVISOR_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 0;
let diagnostic = '';
let fatal;
child.stderr.on('data', c => { if (diagnostic.length < 12000) diagnostic += c.toString().slice(0, 12000 - diagnostic.length); });
function rejectAll(error) {
  fatal = error;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
}
child.on('error', () => rejectAll(new Error('MCP server process could not start.')));
child.stdin.on('error', () => rejectAll(new Error('MCP server stdin closed.')));
child.on('exit', code => rejectAll(new Error(`MCP server exited (${code}). Install dependencies and inspect local stderr.`)));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let value;
  try { value = JSON.parse(line); } catch { rejectAll(new Error('Non-JSON output on MCP stdout.')); return; }
  const p = pending.get(value.id);
  if (!p) return;
  clearTimeout(p.timer); pending.delete(value.id);
  if (value.error) p.reject(new Error('MCP protocol error.')); else p.resolve(value.result);
});
function request(method, params) {
  if (fatal) return Promise.reject(fatal);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out.`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
try {
  const hello = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'advisor-smoke', version: '0.2.0' } });
  assert.ok(hello.serverInfo);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await request('tools/list', {});
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['consult_advisor', 'list_advisors']);
  const list = await request('tools/call', { name: 'list_advisors', arguments: {} });
  assert.ok(!list.isError);
  const review = await request('tools/call', { name: 'consult_advisor', arguments: { question: 'Confirm the offline contract.' } });
  assert.ok(!review.isError);
  assert.match(review.content.map(c => c.text ?? '').join('\n'), /MOCK ONLY/);
  console.log('PASS: MCP stdio initialize, tool discovery, and offline consultation.');
} catch (error) {
  console.error(error.message);
  // This is an opt-in local test with a mock profile only, not production logging.
  if (diagnostic) console.error(diagnostic);
  process.exitCode = 1;
} finally {
  rejectAll(new Error('Smoke test completed.'));
  lines.close();
  child.stdin.end(); child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await rm(work, { recursive: true, force: true });
}
