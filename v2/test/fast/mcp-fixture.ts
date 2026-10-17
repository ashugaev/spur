import { createServer, type IncomingHttpHeaders } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "../helpers/common.js";
import { SPUR_DAEMON_API_VERSION, type ConversationResponse } from "../../src/types.js";
import { projectConversationPage } from "../../src/conversation-page.js";

export const session = {
  id: "test-one",
  project: "test",
  agent: "codex",
  status: "running",
  state: "waiting",
  branch: "feature/test",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  slots: { title: "Task", links: { secret: "private" } },
  prompt: "secret",
  worktreePath: "/private",
};

export async function mcpFixture(host = "127.0.0.1") {
  const root = await createTempDir("spur-mcp-");
  const configPath = join(root, "instance.yaml");
  const calls: { path: string; method: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
  const fixture = {
    root,
    configPath,
    calls,
    projects: [
      { id: "test", name: "Test", configured: true },
      { id: "other", name: "Other", configured: true },
      { id: "loose", name: "Loose", configured: false },
      { id: "shepherd", name: "Shepherd", configured: true, kind: "shepherd" },
    ],
    sessions: [
      session,
      { ...session, id: "other-one", project: "other" },
      { ...session, id: "loose-one", project: "loose" },
    ],
    info: { ok: true, apiVersion: SPUR_DAEMON_API_VERSION, configPath },
    conversation: {
      messages: [],
      durationMs: 0,
      state: "waiting",
      startIndex: 10,
      totalEntries: 14,
      entries: [
        { kind: "tool", output: "private" },
        { kind: "reasoning", text: "private" },
        { kind: "message", role: "assistant", text: "Answer", timestampMs: 123 },
        { kind: "message", role: "user", text: "Followup" },
      ],
    } as ConversationResponse,
    override: undefined as
      | undefined
      | ((
          path: string,
          method: string,
        ) => { status?: number; value?: unknown; raw?: string; hold?: boolean } | undefined),
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    let body: unknown;
    try {
      body = raw ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      body = null;
    }
    const path = request.url ?? "/";
    const method = request.method ?? "GET";
    calls.push({ path, method, headers: request.headers, body });
    const override = fixture.override?.(path, method);
    if (override?.hold) return;
    const value =
      path === "/info"
        ? fixture.info
        : path === "/projects"
          ? fixture.projects
          : path.startsWith("/sessions?")
            ? fixture.sessions
            : path.includes("/conversation")
              ? projectConversationPage(
                  fixture.conversation,
                  session.id,
                  Number(new URL(path, "http://localhost").searchParams.get("limit") ?? 50),
                )
              : path === "/sessions/background"
                ? session
                : fixture.sessions.find(
                    (entry) =>
                      path === `/sessions/${entry.id}` || path === `/sessions/${entry.id}/send`,
                  );
    response.writeHead(override?.status ?? (value === undefined ? 404 : 200), {
      "content-type": "application/json",
    });
    response.end(override?.raw ?? JSON.stringify(override?.value ?? value ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  await writeFile(
    configPath,
    `server:\n  host: ${host}\n  port: ${address.port}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\n`,
  );
  return {
    ...fixture,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    state: fixture,
  };
}
