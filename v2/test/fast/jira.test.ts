import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJiraIssues } from "../../src/jira.js";

interface CapturedRequest {
  authorization: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

const servers: Server[] = [];

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[]; server: Server }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Test server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    server,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  vi.restoreAllMocks();
});

describe("fetchJiraIssues", () => {
  it("uses enhanced JQL search with raw JQL and current page cap", async () => {
    const { baseUrl, requests } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issues: [
            {
              id: "10001",
              key: "WEB-17",
              fields: { summary: " Fix checkout " },
            },
          ],
        }),
      );
    });

    const issues = await fetchJiraIssues({
      baseUrl,
      email: "bot@example.com",
      token: "token",
      jql: "project = WEB AND status != Done",
      maxResults: 500,
    });

    expect(issues).toEqual([
      {
        id: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: `${baseUrl}/browse/WEB-17`,
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:token", "utf8").toString("base64")}`,
    );

    const requestUrl = new URL(requests[0]?.url ?? "/", baseUrl);
    expect(requestUrl.pathname).toBe("/rest/api/3/search/jql");
    expect(requestUrl.searchParams.get("jql")).toBe("project = WEB AND status != Done");
    expect(requestUrl.searchParams.get("fields")).toBe("summary");
    expect(requestUrl.searchParams.get("maxResults")).toBe("100");
  });

  it("rejects instead of hanging when the server writes headers and never ends the body", async () => {
    // fetchJiraIssues waits out the real 30s AbortSignal.timeout(FETCH_TIMEOUT_MS)
    // to observe the abort. Stub AbortSignal.timeout to a 100ms signal instead
    // so this test still exercises "the fetch rejects on abort" without
    // burning 30 real seconds of wall clock — production's timeout constant
    // itself is untouched. Restored in the top-level afterEach.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.timeout(100));

    const { baseUrl } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Deliberately never call response.end(): a mid-body socket stall used
      // to leave the old chunks-accumulator promise pending forever.
    });

    await expect(
      fetchJiraIssues({
        baseUrl,
        email: "bot@example.com",
        token: "token",
        jql: "project = WEB",
        maxResults: 10,
      }),
    ).rejects.toThrow();
  });
});
