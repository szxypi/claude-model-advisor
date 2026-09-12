// Offline contract test only. This adapter is not a language model.
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 262144) throw new Error('input limit');
    chunks.push(chunk);
  }
  const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (req.schema_version !== 1 || typeof req.request_id !== 'string') throw new Error('contract');
  process.stdout.write(JSON.stringify({
    schema_version: 1, request_id: req.request_id,
    answer: '## Assessment\nMOCK ONLY: transport contract succeeded; no model was called.\n\n## Recommendation\nConfigure a real advisor before relying on advice.\n\n## Risks\nThis fixture provides no technical judgment.\n\n## Validation\nRun an integration test against the selected provider.\n\n## Missing context\nReal advisor output.',
  }));
} catch { process.stderr.write('mock adapter failed\n'); process.exitCode = 1; }
