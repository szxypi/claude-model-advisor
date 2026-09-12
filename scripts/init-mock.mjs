import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Creates a new file only; it never overwrites existing user configuration.
const target = resolve(process.argv[2] ?? 'advisor.mock.json');
const config = {
  version: 1, defaultProfile: 'mock',
  profiles: { mock: {
    kind: 'command', model: 'mock-only', enabled: true,
    description: 'Offline fixture; not a real model.',
    command: process.execPath,
    args: [fileURLToPath(new URL('../adapters/mock.mjs', import.meta.url))], envKeys: [],
  } },
};
try {
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${target}`);
} catch { console.error('Cannot create the mock config; use a new writable path.'); process.exitCode = 1; }
