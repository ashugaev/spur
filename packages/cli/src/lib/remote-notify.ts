import type { OrchestratorConfig } from "@composio/ao-core";
import telegramPlugin from "@composio/ao-plugin-notifier-telegram";

/**
 * Send a "Dashboard is ready" notification with a link button.
 * Non-blocking — errors are silently ignored.
 */
export async function notifyRemoteReady(
  config: OrchestratorConfig,
  dashboardUrl: string,
): Promise<void> {
  try {
    const telegramConfig = Object.values(config.notifiers ?? {}).find(
      (entry) => entry?.plugin === "telegram",
    );
    if (!telegramConfig) return;

    const notifier = telegramPlugin.create(telegramConfig);
    await notifier.notifyWithActions?.(
      {
        id: `dashboard-ready-${Date.now()}`,
        type: "system.dashboard_ready",
        sessionId: "",
        projectId: "",
        message: `Dashboard is running at ${dashboardUrl}`,
        priority: "info",
        timestamp: new Date(),
        data: {},
      },
      [{ label: "Open Dashboard", url: dashboardUrl }],
    );
  } catch {
    // Best-effort — don't block dashboard startup
  }
}
