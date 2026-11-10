import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PagesCatalog } from "@/components/PagesCatalog";

function catalog(projectId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <PagesCatalog projectId={projectId} />
    </QueryClientProvider>,
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("Pages catalogue", () => {
  it("links only titles safely in new tabs and returns to the selected project", async () => {
    const title = "A long film title ".repeat(12);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ pages: [{ id: "films", title, url: "/p/films/" }] })),
        ),
    );
    catalog("project one");
    const link = await screen.findByRole("link", { name: title.trim() });
    expect(link).toHaveAttribute("href", "/p/films/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("title", title);
    expect(link.parentElement).toHaveClass("data-row");
    expect(link.parentElement).not.toHaveAttribute("role", "link");
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
      "href",
      "/?project=project%20one",
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ready|Create Page|Open/)).not.toBeInTheDocument();
  });
  it("shows loading before a compact empty state and defaults Agents to /", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((done) => {
          resolve = done;
        }),
      ),
    );
    catalog();
    expect(screen.getByRole("status", { name: "Loading pages" })).toBeInTheDocument();
    expect(screen.queryByText("No pages yet.")).not.toBeInTheDocument();
    resolve(new Response('{"pages":[]}'));
    expect(await screen.findByText("No pages yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/");
  });
  it("shows actual request status and retries without exposing server detail", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("private path", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"pages":[]}'));
    vi.stubGlobal("fetch", fetch);
    catalog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load pages (503).");
    expect(screen.queryByText("private path")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("No pages yet.")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("treats malformed metadata as a request error without fabricated rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"pages":[{"id":"broken"}]}')));
    catalog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load pages.");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
