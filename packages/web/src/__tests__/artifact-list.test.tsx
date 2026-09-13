import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactList,
  DEFAULT_ARTIFACT_SORT,
  type ArtifactSortState,
} from "@/components/ArtifactList";
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
  return screen.getAllByTitle(/\.(txt|png)$/).map((el) => el.textContent ?? "");
}

// ArtifactList is a controlled component (sort state lives in the parent, in
// production SessionDetail); this harness stands in for that parent so tests
// can exercise toggling without duplicating SessionDetail's wiring.
function ControlledArtifactList({
  artifacts: items,
  onPreview = vi.fn(),
  initialSort = DEFAULT_ARTIFACT_SORT,
}: {
  artifacts: SpurSessionArtifact[];
  onPreview?: (artifactId: string) => void;
  initialSort?: ArtifactSortState;
}) {
  const [sort, setSort] = useState<ArtifactSortState>(initialSort);
  return (
    <ArtifactList
      artifacts={items}
      hrefFor={hrefFor}
      onPreview={onPreview}
      onSortChange={setSort}
      sort={sort}
    />
  );
}

describe("ArtifactList", () => {
  it("defaults to updatedAt desc order", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("sorts by Name ascending then descending", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["alpha.txt", "beta.txt", "gamma.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["gamma.txt", "beta.txt", "alpha.txt"]);
  });

  it("sorts by Size descending then ascending", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("sorts by Type ascending then descending", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
  });

  it("sorts by Updated ascending then descending", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(nameOrder()).toEqual(["beta.txt", "gamma.txt", "alpha.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(nameOrder()).toEqual(["alpha.txt", "gamma.txt", "beta.txt"]);
  });

  it("gives each column its own default direction when first selected", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
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
    render(<ControlledArtifactList artifacts={tiedArtifacts} />);
    expect(nameOrder()).toEqual(["tied-1.txt", "tied-2.txt", "tied-3.txt"]);
  });

  it("sorts numbered names numerically, not lexically (F3 regression)", () => {
    const numberedArtifacts: SpurSessionArtifact[] = [
      makeArtifact({ id: "s10", name: "shot-10.png", updatedAt: "2026-04-02T10:00:00.000Z" }),
      makeArtifact({ id: "s2", name: "shot-2.png", updatedAt: "2026-04-02T09:00:00.000Z" }),
      makeArtifact({ id: "s3", name: "shot-3.png", updatedAt: "2026-04-02T08:00:00.000Z" }),
    ];
    render(<ControlledArtifactList artifacts={numberedArtifacts} />);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(nameOrder()).toEqual(["shot-2.png", "shot-3.png", "shot-10.png"]);
  });

  it("marks aria-sort on the th, not the button", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
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
    render(<ControlledArtifactList artifacts={artifacts} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview alpha.txt" }));
    expect(onPreview).toHaveBeenCalledWith("a");
  });

  it("renders a download anchor with the download attribute and hrefFor href", () => {
    render(<ControlledArtifactList artifacts={artifacts} />);
    const downloadLink = screen.getByRole("link", { name: "Download alpha.txt" });
    expect(downloadLink).toHaveAttribute("download", "alpha.txt");
    expect(downloadLink).toHaveAttribute("href", "/api/sessions/sess-1/artifacts/a");
  });

  it("keeps the Updated column visible and hides only Type below sm (F4)", () => {
    const { container } = render(<ControlledArtifactList artifacts={artifacts} />);
    const updatedHeader = screen.getByRole("columnheader", { name: /Updated/ });
    const typeHeader = screen.getByRole("columnheader", { name: /Type/ });
    expect(updatedHeader.className).not.toMatch(/hidden/);
    expect(typeHeader.className).toMatch(/hidden sm:table-cell/);

    // The `th`/`td` classes must stay in lockstep, or the header and its
    // column's cells go responsive at different breakpoints.
    const typeCell = container.querySelector("tbody tr td:nth-child(3)");
    const updatedCell = container.querySelector("tbody tr td:nth-child(4)");
    expect(typeCell?.className).toMatch(/\bhidden\b/);
    expect(typeCell?.className).toMatch(/\bsm:table-cell\b/);
    expect(updatedCell?.className).not.toMatch(/hidden/);
  });

  it("renders an open-in-new-tab action for HTML artifacts only (F5)", () => {
    const htmlArtifacts: SpurSessionArtifact[] = [
      makeArtifact({ id: "h1", name: "report.html", mimeType: "text/html" }),
      makeArtifact({ id: "h2", name: "plain.txt", mimeType: "text/plain" }),
    ];
    render(<ControlledArtifactList artifacts={htmlArtifacts} />);
    expect(screen.getByRole("link", { name: "Open report.html in a new tab" })).toHaveAttribute(
      "href",
      "/api/sessions/sess-1/artifacts/h1",
    );
    expect(
      screen.queryByRole("link", { name: "Open plain.txt in a new tab" }),
    ).not.toBeInTheDocument();
  });
});
