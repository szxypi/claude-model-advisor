import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
async function check(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) await check(path);
    else if (e.name.endsWith('.mjs')) {
      const r = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (r.error || r.status !== 0) throw new Error('JavaScript syntax check failed');
      count++;
    } else if (e.name.endsWith('.json')) {
      JSON.parse(await readFile(path, 'utf8')); count++;
    }
  }
}
await check(root);
console.log(`PASS: ${count} JavaScript/JSON files checked (syntax only; imports not executed).`);
