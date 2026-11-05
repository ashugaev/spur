// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/spur-daemon", () => ({ spurRequest: vi.fn() }));

import { spurRequest } from "@/lib/spur-daemon";
import { GET as pageGet, POST as pagePost } from "@/app/p/[id]/[[...path]]/route";
import {
  DELETE as storeDelete,
  GET as storeGet,
  POST as storePost,
} from "@/app/api/stores/[store]/[...path]/route";
import { SSE_RESPONSE_HEADERS } from "@/lib/store-proxy-route";

const spurRequestMock = vi.mocked(spurRequest);

function pageContext(id: string, path?: string[]) {
  return { params: Promise.resolve(path ? { id, path } : { id }) };
}

function storeContext(store: string, path: string[]) {
  return { params: Promise.resolve({ store, path }) };
}

function post(url: string, headers: Record<string, string>, body: unknown = { data: {} }) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  spurRequestMock.mockReset();
  spurRequestMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  );
});

describe("page route", () => {
  it("redirects /p/<id> to /p/<id>/ with 308", async () => {
    const response = await pageGet(
      new NextRequest("http://host:3000/p/films"),
      pageContext("films"),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("http://host:3000/p/films/");
    expect(spurRequestMock).not.toHaveBeenCalled();
  });

  it("serves index.html for /p/<id>/ and a relative asset by path", async () => {
    await pageGet(new NextRequest("http://host:3000/p/films/"), pageContext("films"));
    expect(spurRequestMock.mock.calls[0]?.[0]).toBe("/pages/films/files/index.html");
    await pageGet(
      new NextRequest("http://host:3000/p/films/js/app.js"),
      pageContext("films", ["js", "app.js"]),
    );
    expect(spurRequestMock.mock.calls[1]?.[0]).toBe("/pages/films/files/js/app.js");
  });

  it("forces a page source on invoke", async () => {
    await pagePost(
      post(
        "http://host:3000/p/films/_spur/actions",
        { "sec-fetch-site": "same-origin" },
        {
          id: "act-00000001",
          action: "pick",
          source: { kind: "snippet", snippetId: "x" },
          payload: {},
        },
      ),
      pageContext("films", ["_spur", "actions"]),
    );
    const [path, init] = spurRequestMock.mock.calls[0] ?? [];
    expect(path).toBe("/stores/page%3Afilms/actions");
    expect(JSON.parse(String(init?.body))).toMatchObject({ source: { kind: "page" } });
  });

  it("streams the page event stream with pinned SSE headers and forwards Last-Event-ID", async () => {
    const encoder = new TextEncoder();
    spurRequestMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("id: 3\nevent: change\ndata: {}\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const request = new NextRequest("http://host:3000/p/films/_spur/events?since=2", {
      headers: { accept: "text/event-stream", "last-event-id": "3" },
    });
    const response = await pageGet(request, pageContext("films", ["_spur", "events"]));
    const [path, init] = spurRequestMock.mock.calls[0] ?? [];
    expect(path).toBe("/pages/films/events?since=2");
    expect(init?.headers).toMatchObject({ accept: "text/event-stream", "last-event-id": "3" });
    expect(init?.signal).toBe(request.signal);
    for (const [name, value] of Object.entries(SSE_RESPONSE_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(await response.text()).toBe("id: 3\nevent: change\ndata: {}\n\n");
  });

  it("404s paths outside the page contract", async () => {
    const response = await pageGet(
      new NextRequest("http://host:3000/p/films/_spur/other"),
      pageContext("films", ["_spur", "other"]),
    );
    expect(response.status).toBe(404);
  });
});

describe("store route origin and content guard", () => {
  const url = "http://host:3000/api/stores/session%3Asp-1/docs/notes";
  const context = () => storeContext("session%3Asp-1", ["docs", "notes"]);

  it("refuses cross-site Sec-Fetch-Site and allows same-origin", async () => {
    expect((await storePost(post(url, { "sec-fetch-site": "cross-site" }), context())).status).toBe(
      403,
    );
    expect((await storePost(post(url, { "sec-fetch-site": "same-site" }), context())).status).toBe(
      403,
    );
    expect(
      (await storePost(post(url, { "sec-fetch-site": "same-origin" }), context())).status,
    ).toBe(200);
    expect(spurRequestMock.mock.calls[0]?.[0]).toBe("/stores/session%3Asp-1/docs/notes");
  });

  it("compares Origin and Host hostnames when Sec-Fetch-Site is absent, ignoring ports", async () => {
    expect(
      (await storePost(post(url, { origin: "https://host", host: "host:3000" }), context())).status,
    ).toBe(200);
    expect(
      (await storePost(post(url, { origin: "https://evil.example", host: "host:3000" }), context()))
        .status,
    ).toBe(403);
  });

  it("uses X-Forwarded-Host over Host", async () => {
    expect(
      (
        await storePost(
          post(url, {
            origin: "https://spur.tailnet.example",
            host: "127.0.0.1:3000",
            "x-forwarded-host": "spur.tailnet.example",
          }),
          context(),
        )
      ).status,
    ).toBe(200);
  });

  it("allows CLI-style requests with neither Origin nor Sec-Fetch-Site", async () => {
    expect((await storePost(post(url, {}), context())).status).toBe(200);
    const deleted = await storeDelete(
      new NextRequest("http://host:3000/api/stores/session%3Asp-1/docs/notes/n1", {
        method: "DELETE",
      }),
      storeContext("session%3Asp-1", ["docs", "notes", "n1"]),
    );
    expect(deleted.status).toBe(200);
  });

  it("answers 415 for a non-JSON body", async () => {
    const request = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    expect((await storePost(request, context())).status).toBe(415);
    expect(spurRequestMock).not.toHaveBeenCalled();
  });

  it("does not guard reads and refuses completion", async () => {
    const read = await storeGet(
      new NextRequest("http://host:3000/api/stores/session%3Asp-1/changes?since=4", {
        headers: { origin: "https://evil.example" },
      }),
      storeContext("session%3Asp-1", ["changes"]),
    );
    expect(read.status).toBe(200);
    expect(spurRequestMock.mock.calls[0]?.[0]).toBe("/stores/session%3Asp-1/changes?since=4");
    const complete = await storePost(
      post("http://host:3000/api/stores/session%3Asp-1/actions/act-1/complete", {}),
      storeContext("session%3Asp-1", ["actions", "act-1", "complete"]),
    );
    expect(complete.status).toBe(404);
  });
});
