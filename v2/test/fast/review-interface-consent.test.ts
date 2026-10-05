import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideConsent,
  parseConsent,
  presentConsent,
  proposeConsent,
  reconcileInterfaceConsent,
  type InterfaceConsent,
} from "../../src/review-interface-consent.js";
import * as metadata from "../../src/metadata.js";
import * as github from "../../src/github-app.js";
import * as state from "../../src/review-state.js";
import type { SessionRecord } from "../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const manifest = {
  version: 1 as const,
  repository: "owner/repo",
  baseBranch: "main",
  surfaces: [
    {
      kind: "CLI" as const,
      id: "run",
      before: ["run accepts no flags"],
      after: ["run accepts --dry-run"],
      constraints: ["dry run creates no process"],
    },
  ],
};
const proposal = () =>
  proposeConsent(
    {
      session: "task",
      repository: "owner/repo",
      branch: "feature/change",
      baseBranch: "main",
      projectId: "project",
      sourceId: "telegram",
      chatId: -100,
      approverUserId: 10,
      manifest,
    },
    null,
    1000,
  );
const click = (challenge: string) => ({
  session: "task",
  projectId: "project",
  sourceId: "telegram",
  chatId: -100,
  actor: 10,
  challenge,
  decision: "approved" as const,
});

describe("semantic interface consent", () => {
  it("presents before/after/constraints before PR exists", () => {
    const record = proposal();
    expect(presentConsent(record)).toContain("run accepts no flags");
    expect(presentConsent(record)).toContain("run accepts --dry-run");
    expect(presentConsent(record)).toContain("dry run creates no process");
    expect(record.decision).toBe("pending");
  });
  it.each(["actor", "chatId", "sourceId", "projectId", "session", "challenge"] as const)(
    "rejects wrong %s",
    (field) => {
      const record = { ...proposal(), delivery: "sent" as const };
      expect(() =>
        decideConsent(
          record,
          {
            ...click(record.challenge),
            [field]: typeof click(record.challenge)[field] === "number" ? 99 : "other",
          },
          2000,
        ),
      ).toThrow();
    },
  );
  it("rejects delivery failure, expiry and replay", () => {
    const record = proposal();
    expect(() => decideConsent(record, click(record.challenge), 2000)).toThrow();
    const sent = { ...record, delivery: "sent" as const };
    expect(() =>
      decideConsent(sent, click(record.challenge), Date.parse(record.expiresAt)),
    ).toThrow();
    const approved = decideConsent(sent, click(record.challenge), 2000);
    expect(approved.decision).toBe("approved");
    expect(approved.outbox).toBe("pending");
    expect(() => decideConsent(approved, click(record.challenge), 2001)).toThrow();
    expect(parseConsent(JSON.parse(JSON.stringify(approved)))).toEqual(approved);
  });
  it("renews nonce/generation and rejects tampered semantic records", () => {
    const old = proposal();
    const next = proposeConsent(old, old, 2000);
    expect(next.generation).toBe(2);
    expect(next.challenge).not.toBe(old.challenge);
    expect(next.manifestDigest).toBe(old.manifestDigest);
    expect(() => parseConsent({ ...old, manifest: { ...manifest, surfaces: [] } })).toThrow();
  });
  it("stores rejection or revocation without approving", () => {
    for (const decision of ["rejected", "revoked"] as const) {
      const record = { ...proposal(), delivery: "sent" as const };
      expect(decideConsent(record, { ...click(record.challenge), decision }, 2000).decision).toBe(
        decision,
      );
    }
  });
  it("leaves pre-PR consent pending for later binding", async () => {
    vi.spyOn(metadata, "readInterfaceConsent").mockReturnValue({
      ...proposal(),
      decision: "approved",
      decidedAt: new Date().toISOString(),
      delivery: "sent",
    });
    vi.spyOn(metadata, "readSession").mockReturnValue(null);
    const publish = vi.spyOn(state, "publishConsentState");
    await reconcileInterfaceConsent("unused", "task");
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    {
      headRepository: "owner/repo",
      baseRepository: "owner/repo",
      headRef: "feature/change",
      previousPr: undefined,
      passes: true,
    },
    {
      headRepository: "contributor/repo",
      baseRepository: "owner/repo",
      headRef: "feature/change",
      previousPr: undefined,
      passes: true,
    },
    {
      headRepository: "contributor/repo",
      baseRepository: "wrong/repo",
      headRef: "feature/change",
      previousPr: undefined,
      passes: false,
    },
    {
      headRepository: "contributor/repo",
      baseRepository: "owner/repo",
      headRef: "feature/other",
      previousPr: undefined,
      passes: false,
    },
    {
      headRepository: "contributor/repo",
      baseRepository: "owner/repo",
      headRef: "feature/change",
      previousPr: { number: 2, headRepository: "contributor/repo" },
      passes: false,
    },
  ])(
    "binds consent to actual PR: $headRepository $baseRepository $headRef $passes",
    async ({ headRepository, baseRepository, headRef, previousPr, passes }) => {
      let record: InterfaceConsent = {
        ...proposal(),
        decision: "revoked",
        decidedAt: new Date().toISOString(),
        delivery: "sent",
      };
      if (previousPr) record.boundPr = previousPr;
      vi.stubEnv("SPUR_REVIEW_APP_CONFIG", "fixture");
      vi.spyOn(metadata, "readInterfaceConsent").mockImplementation(() => record);
      vi.spyOn(metadata, "readSession").mockReturnValue({
        id: "task",
        project: "project",
        branch: "feature/change",
        pr: { repo: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1" },
      } as SessionRecord);
      vi.spyOn(github, "readJson").mockResolvedValue({
        repositories: ["owner/repo"],
        receiptRoot: "/fixture",
        code: { appId: 1, keyPath: "unused" },
        browser: { appId: 2, keyPath: "unused" },
        consent: { approverUserId: 10 },
      });
      vi.spyOn(github.GitHubApp.prototype, "authenticate")
        .mockResolvedValueOnce({
          appId: 1,
          actor: "code[bot]",
          installationId: 1,
          repositoryId: 1,
          permissions: { pull_requests: "write", metadata: "read" },
        })
        .mockResolvedValueOnce({
          appId: 2,
          actor: "browser[bot]",
          installationId: 1,
          repositoryId: 1,
          permissions: { pull_requests: "write", metadata: "read" },
        });
      vi.spyOn(github.GitHubApp.prototype, "request").mockResolvedValue({
        state: "open",
        head: { ref: headRef, sha: "a".repeat(40), repo: { full_name: headRepository } },
        base: { ref: "main", sha: "b".repeat(40), repo: { full_name: baseRepository } },
      });
      const history = vi.spyOn(github.GitHubApp.prototype, "history");
      const publish = vi.spyOn(state, "publishConsentState").mockResolvedValue(undefined);
      const write = vi
        .spyOn(metadata, "writeInterfaceConsent")
        .mockImplementation((_dir, value) => {
          record = value as typeof record;
        });
      if (!passes) {
        await expect(reconcileInterfaceConsent("unused", "task")).rejects.toThrow();
        expect(publish).not.toHaveBeenCalled();
        return;
      }
      await reconcileInterfaceConsent("unused", "task");
      expect(history).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith(
        expect.any(github.GitHubApp),
        expect.objectContaining({ decision: "revoked", task: "task", generation: 1 }),
      );
      expect(write).toHaveBeenCalledWith(
        "unused",
        expect.objectContaining({ outbox: "published" }),
      );
      expect(record.boundPr).toEqual({ number: 1, headRepository });
    },
  );
  it.each(["clean", "lost-reply", "revoke", "newer-rejection", "newer-blocked", "moved-head"])(
    "reconciles actual approved evidence and outbox: %s",
    async (scenario) => {
      let record: InterfaceConsent = {
        ...proposal(),
        decision: "approved",
        decidedAt: new Date().toISOString(),
        delivery: "sent",
      };
      vi.stubEnv("SPUR_REVIEW_APP_CONFIG", "fixture");
      vi.spyOn(metadata, "readInterfaceConsent").mockImplementation(() => record);
      vi.spyOn(metadata, "writeInterfaceConsent").mockImplementation((_dir, value) => {
        record = value;
      });
      vi.spyOn(metadata, "readSession").mockReturnValue({
        id: "task",
        project: "project",
        branch: "feature/change",
        pr: { repo: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1" },
      } as SessionRecord);
      vi.spyOn(github, "readJson").mockResolvedValue({
        repositories: ["owner/repo"],
        receiptRoot: "/fixture",
        code: { appId: 1, keyPath: "unused" },
        browser: { appId: 2, keyPath: "unused" },
        consent: { approverUserId: 10 },
      });
      vi.spyOn(github.GitHubApp.prototype, "authenticate").mockImplementation(async function (
        this: github.GitHubApp,
      ) {
        const id = (this as unknown as { credentials: { appId: number } }).credentials.appId;
        return {
          appId: id,
          actor: id === 1 ? "code[bot]" : "browser[bot]",
          installationId: id,
          repositoryId: 1,
          permissions: { pull_requests: "write", metadata: "read" },
        };
      });
      const H = "a".repeat(40),
        B = "b".repeat(40);
      const laneComments = (["code", "browser"] as const).map((lane, index) => ({
        id: index + 1,
        user: { login: `${lane}[bot]` },
        body: state.stateBody({
          version: 1,
          lane,
          repo: "owner/repo",
          pr: 1,
          session: `${lane}-session`,
          attempt: "attempt",
          H,
          B,
          status: "APPROVED",
          evidenceDigest: "c".repeat(64),
          reviewId: index + 1,
          assessment: {
            status: "required",
            manifest,
            dispositions: [
              { path: "cli.ts", callers: [], surfaceIds: ["run"], evidence: ["fixture"] },
            ],
          },
        }),
      }));
      if (scenario === "newer-blocked") {
        const first = laneComments[0];
        if (!first) throw new Error("missing fixture lane");
        laneComments.push({
          ...first,
          id: 3,
          body: state.stateBody({ ...state.readStateBody(first.body), status: "BLOCKED" }),
        });
      }
      const reviews = [
        { id: 1, user: { login: "code[bot]" }, state: "APPROVED", commit_id: H },
        { id: 2, user: { login: "browser[bot]" }, state: "APPROVED", commit_id: H },
      ];
      if (scenario === "newer-rejection")
        reviews.push({
          id: 3,
          user: { login: "code[bot]" },
          state: "CHANGES_REQUESTED",
          commit_id: H,
        });
      let publicRecord: { id: number; user: { login: string }; body: string } | undefined;
      vi.spyOn(github.GitHubApp.prototype, "history").mockImplementation(async (path) =>
        path.endsWith("/reviews")
          ? reviews
          : [...laneComments, ...(publicRecord ? [publicRecord] : [])],
      );
      let reads = 0,
        posts = 0;
      vi.spyOn(github.GitHubApp.prototype, "request").mockImplementation(
        async (path, method, body) => {
          if (path.endsWith("/pulls/1"))
            return {
              state: "open",
              head: {
                ref: "feature/change",
                sha: scenario === "moved-head" && ++reads > 1 ? "d".repeat(40) : H,
                repo: { full_name: "owner/repo" },
              },
              base: { ref: "main", sha: B, repo: { full_name: "owner/repo" } },
            };
          if (method === "POST") {
            posts++;
            publicRecord = {
              id: 10,
              user: { login: "code[bot]" },
              body: String(github.object(body).body),
            };
            if (scenario === "lost-reply") throw new Error("reply lost after commit");
            return publicRecord;
          }
          if (publicRecord && path.endsWith("/comments/10")) return publicRecord;
          throw new Error("unexpected fixture request");
        },
      );
      if (["newer-rejection", "newer-blocked", "moved-head"].includes(scenario)) {
        await expect(reconcileInterfaceConsent("unused", "task")).rejects.toThrow();
        expect(posts).toBe(0);
        expect(record.outbox).toBe("pending");
        return;
      }
      if (scenario === "lost-reply") {
        await expect(reconcileInterfaceConsent("unused", "task")).rejects.toThrow("reply lost");
        expect(record.outbox).toBe("pending");
        record = parseConsent(JSON.parse(JSON.stringify(record))); // daemon restart
      }
      await reconcileInterfaceConsent("unused", "task");
      expect(posts).toBe(1);
      expect(record.outbox).toBe("published");
      expect(publicRecord?.body).not.toContain("approverUserId");
      expect(publicRecord?.body).not.toContain("chatId");
      if (scenario === "revoke") {
        const renewed = { ...proposeConsent(record, record), delivery: "sent" as const };
        record = decideConsent(renewed, { ...click(renewed.challenge), decision: "revoked" });
        await reconcileInterfaceConsent("unused", "task");
        expect(posts).toBe(2);
        expect(publicRecord?.body).toContain('"generation":2');
        expect(publicRecord?.body).toContain('"decision":"revoked"');
      }
    },
  );
});
