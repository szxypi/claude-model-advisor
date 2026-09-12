import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv[2] ?? 'ok';
if (mode === 'early-exit') process.exit(3);
let s = '';
for await (const c of process.stdin) s += c;
const req = JSON.parse(s);
const respond = answer => process.stdout.write(JSON.stringify({ schema_version: 1, request_id: req.request_id, answer }));
switch (mode) {
  case 'ok': respond('Independent fixture advice.'); break;
  case 'bad-json': process.stdout.write('debug log\n{}'); break;
  case 'empty': break;
  case 'wrong-id': process.stdout.write(JSON.stringify({ schema_version: 1, request_id: 'wrong', answer: 'no' })); break;
  case 'oversize': process.stdout.write('x'.repeat(1100000)); break;
  case 'stderr-limit': process.stderr.write('x'.repeat(20000)); respond('ok'); break;
  case 'exit': process.stderr.write('raw-secret-from-adapter'); process.exitCode = 7; break;
  case 'secret-output': respond(process.env.PRIVATE_API_KEY); break;
  case 'controls': respond('\u0001\u0002'); break;
  case 'env': respond(JSON.stringify({
    inheritedSecret: Boolean(process.env.PARENT_SECRET),
    allowedPresent: Boolean(process.env.PRIVATE_API_KEY),
    recursion: process.env.ADVISOR_DEPTH, cwd: process.cwd(), home: process.env.HOME,
  })); break;
  case 'slow': setTimeout(() => respond('slow fixture advice'), 400); break;
  case 'hang': setInterval(() => {}, 1000); break;
  case 'ignore-term':
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[3], String(process.pid));
    setInterval(() => {}, 1000); break;
  case 'descendant': {
    const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`, process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref(); break;
  }
  default: process.exitCode = 9;
}
