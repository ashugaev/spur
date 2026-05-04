import type { SessionLink } from "./types.js";

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

export interface SessionLinkDisplay {
  label: string;
  text: string;
  url: string;
}

export function isGitHubPrLinkLabel(label: string): boolean {
  return label === "github-pr" || label === "pr";
}

function readUrlPathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function fallbackSegment(url: URL): string | null {
  const segments = readUrlPathSegments(url);
  return segments.at(-1) ?? null;
}

function shortText(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function displayTrackerId(url: URL): string | null {
  const issueKey = `${url}${url.hash}`.match(ISSUE_KEY_RE)?.[0];
  if (issueKey) {
    return issueKey;
  }
  return fallbackSegment(url);
}

function displayPrId(url: URL): string | null {
  const segments = readUrlPathSegments(url);
  const pullIndex = segments.lastIndexOf("pull");
  if (pullIndex >= 0) {
    const number = segments[pullIndex + 1];
    if (number) {
      return `#${number}`;
    }
  }
  const mergeRequestIndex = segments.lastIndexOf("merge_requests");
  if (mergeRequestIndex >= 0) {
    const number = segments[mergeRequestIndex + 1];
    if (number) {
      return `!${number}`;
    }
  }
  return fallbackSegment(url);
}

export function formatSessionLinkDisplay(link: SessionLink): SessionLinkDisplay {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return {
      label: link.label,
      text: shortText(link.label),
      url: link.url,
    };
  }

  if (link.label === "github-pr") {
    const id = displayPrId(url);
    return {
      label: link.label,
      text: id ? `github pr ${shortText(id)}` : "github pr",
      url: url.toString(),
    };
  }

  if (link.label === "pr") {
    const id = displayPrId(url);
    return {
      label: link.label,
      text: id ? `pr ${shortText(id)}` : "pr",
      url: url.toString(),
    };
  }

  if (link.label === "tracker" || link.label === "jira") {
    const id = displayTrackerId(url);
    return {
      label: link.label,
      text: id ? `${link.label} ${shortText(id)}` : link.label,
      url: url.toString(),
    };
  }

  const id = fallbackSegment(url);
  return {
    label: link.label,
    text: id ? `${link.label} ${shortText(id)}` : shortText(link.label),
    url: url.toString(),
  };
}
