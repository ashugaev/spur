import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSentryIssues } from "../../src/sentry.js";

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

describe("fetchSentryIssues", () => {
  it("parses issues from a successful response", async () => {
    const permalink = "https://sentry.io/issues/1/";
    const { baseUrl, requests } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ shortId: "WEB-1", title: "Boom", permalink }]));
    });

    const issues = await fetchSentryIssues({
      token: "token",
      baseUrl,
      org: "acme",
      project: "web",
      query: "is:unresolved",
      limit: 25,
    });

    expect(issues).toEqual([{ shortId: "WEB-1", title: "Boom", permalink }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.authorization).toBe("Bearer token");

    const requestUrl = new URL(requests[0]?.url ?? "/", baseUrl);
    expect(requestUrl.pathname).toBe("/api/0/organizations/acme/issues/");
    expect(requestUrl.searchParams.get("project")).toBe("web");
    expect(requestUrl.searchParams.get("query")).toBe("is:unresolved");
    expect(requestUrl.searchParams.get("limit")).toBe("25");
  });

  it("rejects instead of hanging when the server writes headers and never ends the body", async () => {
    // fetchSentryIssues waits out the real 30s AbortSignal.timeout(FETCH_TIMEOUT_MS)
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
      fetchSentryIssues({
        token: "token",
        baseUrl,
        org: "acme",
        project: "web",
        query: "is:unresolved",
        limit: 25,
      }),
    ).rejects.toThrow();
  });
});
