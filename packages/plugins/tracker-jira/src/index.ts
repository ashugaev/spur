/**
 * tracker-jira plugin — Jira Cloud as an issue tracker.
 *
 * Uses jira-cli (https://github.com/ankitpokhrel/jira-cli) for all Jira API interactions.
 * Install: brew install ankitpokhrel/jira-cli/jira-cli
 * Setup:  jira init
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function jiraCli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("jira", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`jira ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Map Jira status category names to our Issue state.
 * Jira status categories: "new", "indeterminate", "done"
 * (returned as statusCategory.key in the raw Jira REST API JSON)
 */
function mapState(statusCategoryKey: string): Issue["state"] {
  switch (statusCategoryKey.toLowerCase()) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    default:
      return "open";
  }
}

/** Simple recursive ADF (Atlassian Document Format) → plain text converter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adfToPlainText(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;

  // Text node
  if (node.type === "text") {
    return node.text ?? "";
  }

  // Recursively process child content
  if (Array.isArray(node.content)) {
    const parts: string[] = node.content.map(adfToPlainText);

    switch (node.type) {
      case "paragraph":
      case "heading":
      case "blockquote":
        return parts.join("") + "\n\n";
      case "listItem":
        return "- " + parts.join("") + "\n";
      case "bulletList":
      case "orderedList":
        return parts.join("");
      case "codeBlock":
        return "```\n" + parts.join("") + "\n```\n\n";
      default:
        return parts.join("");
    }
  }

  return "";
}

function getBaseUrl(project: ProjectConfig): string {
  const trackerConfig = project.tracker as Record<string, unknown> | undefined;
  const configUrl = trackerConfig?.baseUrl as string | undefined;
  const envUrl = process.env["JIRA_URL"] ?? process.env["JIRA_HOST"];
  const url = configUrl ?? envUrl;
  if (!url) {
    throw new Error(
      "Jira base URL not configured. Set tracker.baseUrl in project config or JIRA_URL env var.",
    );
  }
  return url.replace(/\/+$/, "");
}

function getProjectKey(project: ProjectConfig): string {
  const trackerConfig = project.tracker as Record<string, unknown> | undefined;
  const key = trackerConfig?.projectKey as string | undefined;
  if (!key) {
    throw new Error("Jira project key not configured. Set tracker.projectKey in project config.");
  }
  return key;
}

// ---------------------------------------------------------------------------
// JSON response types (jira-cli --raw returns raw Jira REST API JSON)
// ---------------------------------------------------------------------------

interface JiraIssueRaw {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string; statusCategory: { key: string } };
    labels: string[];
    assignee: { displayName: string; emailAddress?: string } | null;
    priority: { name: string; id: string } | null;
    issuetype: { name: string };
  };
}

function parseIssueJson(raw: string): JiraIssueRaw {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse Jira issue JSON: ${raw.slice(0, 200)}`);
  }
}

function toIssue(data: JiraIssueRaw, baseUrl: string): Issue {
  const fields = data.fields;
  return {
    id: data.key,
    title: fields.summary ?? "",
    description:
      typeof fields.description === "string"
        ? fields.description
        : adfToPlainText(fields.description),
    url: `${baseUrl}/browse/${data.key}`,
    state: mapState(fields.status?.statusCategory?.key ?? "new"),
    statusLabel: fields.status?.name,
    labels: fields.labels ?? [],
    assignee: fields.assignee?.displayName,
    priority: fields.priority?.id ? Number(fields.priority.id) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await jiraCli(["issue", "view", identifier, "--raw"]);
      const data = parseIssueJson(raw);
      return toIssue(data, getBaseUrl(project));
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const raw = await jiraCli(["issue", "view", identifier, "--raw"]);
      const data: { fields: { status: { statusCategory: { key: string } } } } = JSON.parse(raw);
      return data.fields.status.statusCategory.key.toLowerCase() === "done";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      return `${getBaseUrl(project)}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Example: https://myorg.atlassian.net/browse/WEBDEV-123 → WEBDEV-123
      const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
      if (match) {
        return match[1];
      }
      const parts = url.split("/");
      return parts[parts.length - 1] ?? url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return identifier;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Jira issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const projectKey = getProjectKey(project);
      const args = ["issue", "list", "-p", projectKey, "--raw"];

      // Build JQL parts for filters that need raw JQL
      const jqlParts: string[] = [];

      if (filters.state === "closed") {
        jqlParts.push("statusCategory = Done");
      } else if (filters.state !== "all") {
        jqlParts.push("NOT statusCategory = Done");
      }

      if (filters.iteration) {
        if (filters.iteration.toLowerCase() === "current") {
          jqlParts.push("sprint in openSprints()");
        } else {
          jqlParts.push(`sprint = "${filters.iteration}"`);
        }
      }

      if (filters.labels && filters.labels.length > 0) {
        const labelClauses = filters.labels.map((l) => `labels = "${l}"`);
        jqlParts.push(`(${labelClauses.join(" OR ")})`);
      }

      if (filters.assignee) {
        args.push("-a", filters.assignee);
      }

      if (jqlParts.length > 0) {
        args.push("-q", jqlParts.join(" AND "));
      }

      const limit = filters.limit ?? 30;
      args.push("--paginate", String(limit));

      const raw = await jiraCli(args);
      if (!raw) return [];

      const issues: JiraIssueRaw[] = JSON.parse(raw);
      const baseUrl = getBaseUrl(project);
      return issues.map((issue) => toIssue(issue, baseUrl));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Handle state transitions via `jira issue move`
      if (update.state === "in_progress") {
        await jiraCli(["issue", "move", identifier, "In Progress"]);
      } else if (update.state === "closed") {
        await jiraCli(["issue", "move", identifier, "Done"]);
      } else if (update.state === "open") {
        await jiraCli(["issue", "move", identifier, "To Do"]);
      }

      // Handle comment via `jira issue comment add`
      if (update.comment) {
        await jiraCli(["issue", "comment", "add", identifier, update.comment]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const projectKey = getProjectKey(project);
      const args = [
        "issue",
        "create",
        "-p",
        projectKey,
        "-t",
        "Task",
        "-s",
        input.title,
        "--no-input",
        "--raw",
      ];

      if (input.description) {
        args.push("-b", input.description);
      }

      const raw = await jiraCli(args);
      const data: { key: string } = JSON.parse(raw);

      return this.getIssue(data.key, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira Cloud Issues (via jira-cli)",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
