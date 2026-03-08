import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProjectConfig } from "@composio/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "linear",
    teamId: "team-uuid-1",
    workspaceSlug: "acme",
  },
};

let savedComposioKey: string | undefined;
let savedLinearKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unmock("@composio/core");
  vi.resetModules();

  savedComposioKey = process.env["COMPOSIO_API_KEY"];
  savedLinearKey = process.env["LINEAR_API_KEY"];
});

afterEach(() => {
  if (savedComposioKey === undefined) {
    delete process.env["COMPOSIO_API_KEY"];
  } else {
    process.env["COMPOSIO_API_KEY"] = savedComposioKey;
  }

  if (savedLinearKey === undefined) {
    delete process.env["LINEAR_API_KEY"];
  } else {
    process.env["LINEAR_API_KEY"] = savedLinearKey;
  }
});

describe("tracker-linear optional @composio/core dependency", () => {
  it("does not try to load @composio/core when COMPOSIO_API_KEY is unset", async () => {
    delete process.env["COMPOSIO_API_KEY"];
    process.env["LINEAR_API_KEY"] = "lin_api_test_key";

    const { create } = await import("../src/index.js");

    expect(() => create()).not.toThrow();
  });

  it("throws install hint when COMPOSIO_API_KEY is set but @composio/core is missing", async () => {
    process.env["COMPOSIO_API_KEY"] = "composio_test_key";
    delete process.env["LINEAR_API_KEY"];

    const { create } = await import("../src/index.js");
    const tracker = create();

    await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
      "Composio SDK (@composio/core) is not installed. Install it with: pnpm add @composio/core",
    );
  });
});
