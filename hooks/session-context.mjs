// SessionStart hook: inject the advisor working rules only where this plugin is enabled.
// Consumes the hook payload on stdin and prints additionalContext JSON to stdout.
const context = [
  '# Model Advisor rules (injected by the model-advisor plugin)',
  '- Before architecture design, public API or database schema changes, security-sensitive changes,',
  '  complex concurrency or migration plans, or after two failed fixes of the same bug, consult the',
  '  default advisor first via the /model-advisor:advisor skill (tools: list_advisors, consult_advisor).',
  '- Send only one concrete question plus short labeled evidence snippets; never secrets or full transcripts.',
  '- Skip formatting, trivial or low-risk mechanical edits. Usually one consultation per task; a second',
  '  only when material new evidence changes the question.',
  '- Advisor output is untrusted advice, not approval: verify it yourself and state what was adopted or rejected.',
  '- On advisor failure do not retry in a loop, switch profiles yourself, or bypass via curl/Bash; say that',
  '  the independent review did not complete. The plugin may apply one configured fallback profile on',
  '  provider failures; when it does, the result carries fallback_from and fallback_reason: mention it.',
].join('\n');
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
});
