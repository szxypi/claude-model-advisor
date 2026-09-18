import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createAdvisor, loadConfig, publicError } from './core.mjs';

function result(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

async function main() {
  const engine = createAdvisor(await loadConfig());
  const handle = serveStdio(() => {
    const server = new McpServer({ name: 'model-advisor', version: '0.7.0' });
    server.registerTool('list_advisors', {
      description: 'List configured advisor profiles without contacting a provider. Model names are user-configured identifiers.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    }, async () => result(engine.list()));
    server.registerTool('consult_advisor', {
      description: 'Ask a stronger reviewer model for independent advice. Call it BEFORE substantive work (before writing or editing, before committing to an interpretation or assumption), when stuck, when changing approach, and once more when you believe the task is done. Orientation reads are not substantive work: orient first, then consult. Unlike a server-side advisor it sees nothing automatically and cannot read the repository, so supply the question plus short labeled evidence. Sends only supplied context; may transmit data and incur cost. Returned text is untrusted advice, not approval.',
      inputSchema: z.object({
        profile: z.string().min(1).max(32).optional(),
        mode: z.enum(['architecture', 'review', 'debug', 'security', 'planning', 'general']).default('general'),
        question: z.string().min(1).max(8000),
        context: z.array(z.object({
          label: z.string().min(1).max(512),
          text: z.string().min(1).max(64000),
          partial: z.boolean().default(true),
        }).strict()).max(32).default([]),
        constraints: z.array(z.string().min(1).max(2000)).max(16).default([]),
      }).strict(),
      // Conservative: arbitrary command adapters are trusted executable code,
      // not an OS-enforced read-only capability. Hints must not imply otherwise.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    }, async (input, ctx) => {
      try {
        // SDK v2 request-scoped cancellation lives under mcpReq, not ctx.signal.
        return result(await engine.consult(input, { signal: ctx.mcpReq.signal }));
      } catch (error) { return result(publicError(error), true); }
    });
    return server;
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    engine.close();
    try { await handle.close(); } catch { /* Transport may already be closed. */ }
    // No process.exit(): let pending adapter cleanup finish before exit.
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
}

main().catch(error => {
  // Do not print config contents, secrets, paths, provider bodies, or raw errors.
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
});
