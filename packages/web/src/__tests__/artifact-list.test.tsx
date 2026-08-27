import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactList } from "@/components/ArtifactList";
import type { SpurSessionArtifact } from "@/lib/types";

function makeArtifact(overrides: Partial<SpurSessionArtifact>): SpurSessionArtifact {
  return {
    id: "a",
    name: "a.txt",
    size: 100,
    mimeType: "text/plain",
    kind: "download",
    origin: "intentional",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    ...overrides,
  };
}

const artifacts: SpurSessionArtifact[] = [
  makeArtifact({
    id: "b",
    name: "beta.txt",
    size: 300,
    kind: "text",
    updatedAt: "2026-04-02T09:00:00.000Z",
  }),
  makeArtifact({
    id: "a",
    name: "alpha.txt",
    size: 100,
    kind: "download",
    updatedAt: "2026-04-02T11:00:00.000Z",
  }),
  makeArtifact({
    id: "c",
    name: "gamma.txt",
    size: 200,
    kind: "image",
    updatedAt: "2026-04-02T10:00:00.000Z",
  }),
];

function hrefFor(id: string): string {
  return `/api/sessions/sess-1/artifacts/${id}`;
}

function nameOrder(): string[] {
  return screen.getAllByTitle(/\.txt$/).map((el) => el.textContent ?? "");
}

describe("ArtifactList", () => {
  it("defaults to updatedAt desc order", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("sorts by Name ascending then descending", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["alpha.txt", "beta.txt", "gamma.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["gamma.txt", "beta.txt", "alpha.txt"]);
  });

  it("sorts by Size descending then ascending", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("sorts by Type ascending then descending", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
  });

  it("sorts by Updated ascending then descending", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("gives each column its own default direction when first selected", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    // name defaults to ascending
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["alpha.txt", "beta.txt", "gamma.txt"]);
    // type defaults to ascending
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
    // size defaults to descending
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
    // updatedAt defaults to descending
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("preserves payload order for ties in the default desc view (regression)", () => {
    const tiedArtifacts: SpurSessionArtifact[] = [
      makeArtifact({ id: "t1", name: "tied-1.txt", updatedAt: "2026-04-02T10:00:00.000Z" }),
      makeArtifact({ id: "t2", name: "tied-2.txt", updatedAt: "2026-04-02T10:00:00.000Z" }),
      makeArtifact({ id: "t3", name: "tied-3.txt", updatedAt: "2026-04-02T10:00:00.000Z" }),
    ];
    render(<ArtifactList artifacts={tiedArtifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    expect(nameOrder()).toEqual(["tied-1.txt", "tied-2.txt", "tied-3.txt"]);
  });

  it("marks aria-sort on the th, not the button", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    const updatedHeader = screen.getByRole("columnheader", { name: /Updated/ });
    expect(updatedHeader).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("button", { name: "Updated" })).not.toHaveAttribute("aria-sort");

    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    expect(nameHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("calls onPreview with the artifact id from the view action", () => {
    const onPreview = vi.fn();
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview alpha.txt" }));
    expect(onPreview).toHaveBeenCalledWith("a");
  });

  it("renders a download anchor with the download attribute and hrefFor href", () => {
    render(<ArtifactList artifacts={artifacts} hrefFor={hrefFor} onPreview={vi.fn()} />);
    const downloadLink = screen.getByRole("link", { name: "Download alpha.txt" });
    expect(downloadLink).toHaveAttribute("download", "alpha.txt");
    expect(downloadLink).toHaveAttribute("href", "/api/sessions/sess-1/artifacts/a");
  });
});
