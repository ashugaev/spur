import type { InboundEnvelope, OrchestratorConfig } from "@composio/ao-core";

export interface SourceReplyDispatchParams {
  config: OrchestratorConfig;
  envelope: InboundEnvelope;
  message: string;
}

export interface SourceReplyAdapter {
  source: string;
  sendReply(params: SourceReplyDispatchParams): Promise<void>;
}
