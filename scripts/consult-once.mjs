import { readFile } from 'node:fs/promises';
import { loadConfig, createAdvisor, publicError } from '../src/core.mjs';
// Explicit provider diagnostic, not an MCP server. Calling a real profile may cost money.
try {
  if (!process.argv[2]) throw new Error('missing request file');
  const engine = createAdvisor(await loadConfig());
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(await engine.consult(input), null, 2));
  engine.close();
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
