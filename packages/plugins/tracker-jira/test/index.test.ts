import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const { jiraMock } = vi.hoisted(() => ({ jiraMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: jiraMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "jira",
    projectKey: "WEBDEV",
    baseUrl: "https://myorg.atlassian.net",
  },
};

function mockJira(result: unknown) {
  jiraMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockJiraRaw(stdout: string) {
  jiraMock.mockResolvedValueOnce({ stdout });
}

function mockJiraError(msg = "Command failed") {
  jiraMock.mockRejectedValueOnce(new Error(msg));
}

const sampleIssue = {
  key: "WEBDEV-123",
  fields: {
    summary: "Fix login bug",
    description: "Users can't log in with SSO",
    status: {
      name: "To Do",
      statusCategory: { key: "new" },
    },
    labels: ["bug", "priority-high"],
    assignee: { displayName: "Alice Smith", emailAddress: "alice@example.com" },
    priority: { name: "High", id: "2" },
    issuetype: { name: "Bug" },
  },
};

const sampleIssueAdf = {
  ...sampleIssue,
  fields: {
    ...sampleIssue.fields,
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users can't log in with SSO" }],
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-jira plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("jira");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("jira");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockJira(sampleIssue);
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue).toEqual({
        id: "WEBDEV-123",
        title: "Fix login bug",
        description: "Users can't log in with SSO",
        url: "https://myorg.atlassian.net/browse/WEBDEV-123",
        state: "open",
        labels: ["bug", "priority-high"],
        assignee: "Alice Smith",
        priority: 2,
      });
    });

    it("calls jira issue view with --raw", async () => {
      mockJira(sampleIssue);
      await tracker.getIssue("WEBDEV-123", project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        ["issue", "view", "WEBDEV-123", "--raw"],
        expect.any(Object),
      );
    });

    it("maps indeterminate status category to in_progress", async () => {
      mockJira({
        ...sampleIssue,
        fields: {
          ...sampleIssue.fields,
          status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        },
      });
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps done status category to closed", async () => {
      mockJira({
        ...sampleIssue,
        fields: {
          ...sampleIssue.fields,
          status: { name: "Done", statusCategory: { key: "done" } },
        },
      });
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.state).toBe("closed");
    });

    it("converts ADF description to plain text", async () => {
      mockJira(sampleIssueAdf);
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.description).toContain("Users can't log in with SSO");
    });

    it("handles null description", async () => {
      mockJira({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, description: null },
      });
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.description).toBe("");
    });

    it("handles null assignee", async () => {
      mockJira({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, assignee: null },
      });
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("propagates CLI errors", async () => {
      mockJiraError("issue not found");
      await expect(tracker.getIssue("WEBDEV-999", project)).rejects.toThrow("issue not found");
    });

    it("throws on malformed JSON response", async () => {
      jiraMock.mockResolvedValueOnce({ stdout: "not json{" });
      await expect(tracker.getIssue("WEBDEV-123", project)).rejects.toThrow();
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns true for done status category", async () => {
      mockJira({
        fields: { status: { statusCategory: { key: "done" } } },
      });
      expect(await tracker.isCompleted("WEBDEV-123", project)).toBe(true);
    });

    it("returns false for new status category", async () => {
      mockJira({
        fields: { status: { statusCategory: { key: "new" } } },
      });
      expect(await tracker.isCompleted("WEBDEV-123", project)).toBe(false);
    });

    it("returns false for indeterminate status category", async () => {
      mockJira({
        fields: { status: { statusCategory: { key: "indeterminate" } } },
      });
      expect(await tracker.isCompleted("WEBDEV-123", project)).toBe(false);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates correct URL", () => {
      expect(tracker.issueUrl("WEBDEV-42", project)).toBe(
        "https://myorg.atlassian.net/browse/WEBDEV-42",
      );
    });

    it("strips trailing slash from baseUrl", () => {
      const proj = {
        ...project,
        tracker: { ...project.tracker, baseUrl: "https://myorg.atlassian.net/" },
      };
      expect(tracker.issueUrl("WEBDEV-42", proj)).toBe(
        "https://myorg.atlassian.net/browse/WEBDEV-42",
      );
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts issue key from Jira URL", () => {
      expect(
        tracker.issueLabel!("https://myorg.atlassian.net/browse/WEBDEV-123", project),
      ).toBe("WEBDEV-123");
    });

    it("falls back to last URL segment", () => {
      expect(tracker.issueLabel!("https://example.com/something/ABC-1", project)).toBe("ABC-1");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("returns identifier as-is (Jira key)", () => {
      expect(tracker.branchName("WEBDEV-4390", project)).toBe("WEBDEV-4390");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and URL", async () => {
      mockJira(sampleIssue);
      const prompt = await tracker.generatePrompt("WEBDEV-123", project);
      expect(prompt).toContain("Fix login bug");
      expect(prompt).toContain("https://myorg.atlassian.net/browse/WEBDEV-123");
      expect(prompt).toContain("Jira issue WEBDEV-123");
    });

    it("includes labels when present", async () => {
      mockJira(sampleIssue);
      const prompt = await tracker.generatePrompt("WEBDEV-123", project);
      expect(prompt).toContain("bug, priority-high");
    });

    it("includes description", async () => {
      mockJira(sampleIssue);
      const prompt = await tracker.generatePrompt("WEBDEV-123", project);
      expect(prompt).toContain("Users can't log in with SSO");
    });

    it("omits labels section when no labels", async () => {
      mockJira({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, labels: [] },
      });
      const prompt = await tracker.generatePrompt("WEBDEV-123", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits description section when body is empty", async () => {
      mockJira({
        ...sampleIssue,
        fields: { ...sampleIssue.fields, description: null },
      });
      const prompt = await tracker.generatePrompt("WEBDEV-123", project);
      expect(prompt).not.toContain("## Description");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues", async () => {
      mockJira([
        sampleIssue,
        {
          ...sampleIssue,
          key: "WEBDEV-456",
          fields: { ...sampleIssue.fields, summary: "Another" },
        },
      ]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("WEBDEV-123");
      expect(issues[1].id).toBe("WEBDEV-456");
    });

    it("passes project key via -p flag", async () => {
      mockJira([]);
      await tracker.listIssues!({}, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["-p", "WEBDEV"]),
        expect.any(Object),
      );
    });

    it("adds closed status JQL filter", async () => {
      mockJira([]);
      await tracker.listIssues!({ state: "closed" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["-q", "statusCategory = Done"]),
        expect.any(Object),
      );
    });

    it("adds open status JQL filter by default (NOT operator)", async () => {
      mockJira([]);
      await tracker.listIssues!({}, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["-q", "NOT statusCategory = Done"]),
        expect.any(Object),
      );
    });

    it("skips status filter for state=all", async () => {
      mockJira([]);
      await tracker.listIssues!({ state: "all" }, project);
      const callArgs = jiraMock.mock.calls[0][1] as string[];
      expect(callArgs).not.toContain("-q");
    });

    it("passes label filter via JQL", async () => {
      mockJira([]);
      await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["-q", expect.stringContaining('labels = "bug"')]),
        expect.any(Object),
      );
    });

    it("passes assignee filter via -a flag", async () => {
      mockJira([]);
      await tracker.listIssues!({ assignee: "alice" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["-a", "alice"]),
        expect.any(Object),
      );
    });

    it("respects custom limit via --paginate", async () => {
      mockJira([]);
      await tracker.listIssues!({ limit: 5 }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        expect.arrayContaining(["--paginate", "5"]),
        expect.any(Object),
      );
    });

    it("returns empty array for empty output", async () => {
      mockJiraRaw("");
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    it("transitions to In Progress", async () => {
      jiraMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { state: "in_progress" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        ["issue", "move", "WEBDEV-123", "In Progress"],
        expect.any(Object),
      );
    });

    it("transitions to Done", async () => {
      jiraMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { state: "closed" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        ["issue", "move", "WEBDEV-123", "Done"],
        expect.any(Object),
      );
    });

    it("transitions to To Do", async () => {
      jiraMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { state: "open" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        ["issue", "move", "WEBDEV-123", "To Do"],
        expect.any(Object),
      );
    });

    it("ignores labels (read-only)", async () => {
      jiraMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { labels: ["bug"] }, project);
      expect(jiraMock).not.toHaveBeenCalled();
    });

    it("ignores assignee (read-only)", async () => {
      jiraMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { assignee: "bob" }, project);
      expect(jiraMock).not.toHaveBeenCalled();
    });

    it("adds comment via jira issue comment add", async () => {
      jiraMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("WEBDEV-123", { comment: "Working on this" }, project);
      expect(jiraMock).toHaveBeenCalledWith(
        "jira",
        ["issue", "comment", "add", "WEBDEV-123", "Working on this"],
        expect.any(Object),
      );
    });

    it("handles state + comment in one call (labels ignored)", async () => {
      jiraMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "WEBDEV-123",
        { state: "closed", labels: ["done"], comment: "Done!" },
        project,
      );
      // move + comment = 2 calls (labels ignored)
      expect(jiraMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // First call: jira issue create --raw returns JSON with key
      mockJira({ key: "WEBDEV-999" });
      // Second call: getIssue fetches the created issue
      mockJira({
        key: "WEBDEV-999",
        fields: {
          summary: "New issue",
          description: "Description",
          status: { name: "To Do", statusCategory: { key: "new" } },
          labels: [],
          assignee: null,
          priority: null,
          issuetype: { name: "Task" },
        },
      });

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Description" },
        project,
      );
      expect(issue).toMatchObject({ id: "WEBDEV-999", title: "New issue", state: "open" });
    });

    it("passes only summary and description (no labels/assignee)", async () => {
      mockJira({ key: "WEBDEV-1000" });
      mockJira({
        key: "WEBDEV-1000",
        fields: {
          summary: "Bug",
          description: "Crash",
          status: { name: "To Do", statusCategory: { key: "new" } },
          labels: [],
          assignee: null,
          priority: null,
          issuetype: { name: "Task" },
        },
      });

      await tracker.createIssue!(
        { title: "Bug", description: "Crash", labels: ["bug"], assignee: "alice" },
        project,
      );
      // Labels and assignee should not be passed
      const createArgs = jiraMock.mock.calls[0][1] as string[];
      expect(createArgs).not.toContain("-l");
      expect(createArgs).not.toContain("-a");
      expect(createArgs).toContain("--no-input");
      expect(createArgs).toContain("--raw");
    });
  });

  // ---- ADF conversion ----------------------------------------------------

  describe("ADF to plain text", () => {
    it("handles nested ADF with multiple block types", async () => {
      mockJira({
        ...sampleIssue,
        fields: {
          ...sampleIssue.fields,
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "First paragraph" }],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Item one" }],
                      },
                    ],
                  },
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Item two" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "codeBlock",
                content: [{ type: "text", text: "const x = 1;" }],
              },
            ],
          },
        },
      });
      const issue = await tracker.getIssue("WEBDEV-123", project);
      expect(issue.description).toContain("First paragraph");
      expect(issue.description).toContain("Item one");
      expect(issue.description).toContain("Item two");
      expect(issue.description).toContain("const x = 1;");
    });
  });

  // ---- config errors -----------------------------------------------------

  describe("config errors", () => {
    it("throws when baseUrl is missing and no env vars set", () => {
      const proj = { ...project, tracker: { plugin: "jira", projectKey: "WEBDEV" } };
      const origUrl = process.env["JIRA_URL"];
      const origHost = process.env["JIRA_HOST"];
      delete process.env["JIRA_URL"];
      delete process.env["JIRA_HOST"];
      try {
        expect(() => tracker.issueUrl("WEBDEV-1", proj)).toThrow("Jira base URL not configured");
      } finally {
        if (origUrl) process.env["JIRA_URL"] = origUrl;
        if (origHost) process.env["JIRA_HOST"] = origHost;
      }
    });

    it("falls back to JIRA_URL env var", () => {
      const proj = { ...project, tracker: { plugin: "jira", projectKey: "WEBDEV" } };
      process.env["JIRA_URL"] = "https://env.atlassian.net";
      try {
        expect(tracker.issueUrl("WEBDEV-1", proj)).toBe(
          "https://env.atlassian.net/browse/WEBDEV-1",
        );
      } finally {
        delete process.env["JIRA_URL"];
      }
    });

    it("falls back to JIRA_HOST env var", () => {
      const proj = { ...project, tracker: { plugin: "jira", projectKey: "WEBDEV" } };
      const origUrl = process.env["JIRA_URL"];
      delete process.env["JIRA_URL"];
      process.env["JIRA_HOST"] = "https://host.atlassian.net";
      try {
        expect(tracker.issueUrl("WEBDEV-1", proj)).toBe(
          "https://host.atlassian.net/browse/WEBDEV-1",
        );
      } finally {
        delete process.env["JIRA_HOST"];
        if (origUrl) process.env["JIRA_URL"] = origUrl;
      }
    });

    it("throws when projectKey is missing in listIssues", async () => {
      const proj = {
        ...project,
        tracker: { plugin: "jira", baseUrl: "https://myorg.atlassian.net" },
      };
      await expect(tracker.listIssues!({}, proj)).rejects.toThrow(
        "Jira project key not configured",
      );
    });
  });
});
