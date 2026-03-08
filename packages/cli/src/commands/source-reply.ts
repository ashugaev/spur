import chalk from "chalk";
import type { Command } from "commander";
import {
  createInboundContextStore,
  loadConfig,
  type Session,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { getSourceReplyAdapter } from "../lib/source-replies/index.js";

function isOrchestratorSession(session: Session): boolean {
  return session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator");
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

export function registerSourceReply(program: Command): void {
  program
    .command("source-reply")
    .description(
      "Reply to the next pending inbound source message for an orchestrator session",
    )
    .argument("<session>", "Orchestrator session ID")
    .argument("[message...]", "Reply text")
    .action(async (sessionId: string, messageParts: string[]) => {
      const message = messageParts.join(" ").trim();
      if (!message) {
        fail("No reply text provided");
      }

      const config = loadConfig();
      const sessionManager = await getSessionManager(config);
      const session = await sessionManager.get(sessionId);
      if (!session) {
        fail(`Session "${sessionId}" not found`);
      }

      if (!isOrchestratorSession(session)) {
        fail(`Session "${sessionId}" is not an orchestrator session`);
      }

      const inboundContextStore = createInboundContextStore(config);

      let envelope;
      try {
        envelope = await inboundContextStore.peekNext(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Failed to load pending source context: ${msg}`);
      }

      if (!envelope) {
        fail(
          `No pending source context for "${sessionId}". Wait for a source message first, then retry.`,
        );
      }

      const adapter = getSourceReplyAdapter(envelope.source);
      if (!adapter) {
        fail(`No source-reply adapter registered for source "${envelope.source}"`);
      }

      try {
        await adapter.sendReply({
          config,
          envelope,
          message,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail(`Failed to send source reply: ${msg}`);
      }

      const acknowledged = await inboundContextStore.ack(sessionId, envelope.id);
      if (!acknowledged) {
        fail(`Reply sent but failed to acknowledge context envelope "${envelope.id}"`);
      }

      console.log(
        chalk.green(
          `Replied via ${envelope.source} for ${sessionId} (context ${envelope.id}).`,
        ),
      );
    });
}
