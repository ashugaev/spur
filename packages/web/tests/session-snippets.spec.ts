import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildSnippetActionPrompt,
  parseSnippetActionPrompt,
  type SnippetPromptFields,
} from "../src/lib/snippets/snippet-protocol";
import { test, expect, makeWorkingSession, mockSessions, type Page } from "./fixtures.js";

// Real-browser proof for interactive snippets: sandbox and CSP, focus and
// fullscreen mechanics, hot revision replace, abuse gates. Every /api route is
// mocked; an unmocked request (a CSP hole would produce one) fails the test via
// the auto route guard in fixtures.ts.

const SESSION_ID = "snip-ab12";
// Playwright runs from packages/web (playwright.config.ts lives there).
const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/snippets");
const SHOT_DIR = process.env.SPUR_SESSION_ARTIFACTS_DIR
  ? join(process.env.SPUR_SESSION_ARTIFACTS_DIR, "snippets-ui")
  : undefined;

type FixtureName =
  | "candidate-picker"
  | "auto-invoke"
  | "focus-steal"
  | "probe"
  | "navigate"
  | "resizable";

interface PublishedFile {
  html: string;
  updatedAt: string;
}

interface Post {
  raw: string;
  body: { message: string; queue?: boolean };
}

class Rig {
  files = new Map<string, PublishedFile>();
  queued: string[] = [];
  messages: Array<{ role: "user" | "assistant"; text: string; timestampMs: number }> = [];
  posts: Post[] = [];
  sendStatus = 200;
  sessionState: "working" | "waiting" = "working";
  private clock = Date.parse("2026-11-03T10:00:00.000Z");

  publish(snippetId: string, html: string): void {
    this.clock += 1000;
    this.files.set(`snippet.${SESSION_ID}.${snippetId}.html`, {
      html,
      updatedAt: new Date(this.clock).toISOString(),
    });
  }

  publishFixture(
    name: FixtureName,
    options: { revision?: number; instance?: string; responds?: string } = {},
  ): void {
    this.publish(name, fixtureHtml(name, options));
  }

  remove(snippetId: string): void {
    this.files.delete(`snippet.${SESSION_ID}.${snippetId}.html`);
  }

  artifacts() {
    return [...this.files.entries()].map(([name, file]) => ({
      id: name,
      name,
      size: Buffer.byteLength(file.html),
      mimeType: "text/html; charset=utf-8",
      kind: "download" as const,
      origin: "intentional" as const,
      createdAt: file.updatedAt,
      updatedAt: file.updatedAt,
    }));
  }
}

function fixtureHtml(
  name: FixtureName,
  options: { revision?: number; instance?: string; responds?: string },
): string {
  const text = readFileSync(join(FIXTURE_DIR, `${name}.html`), "utf8");
  return text
    .replaceAll("{{SESSION}}", SESSION_ID)
    .replaceAll("{{INSTANCE}}", options.instance ?? `inst-${name}-0001`.slice(0, 24))
    .replaceAll("{{REVISION}}", String(options.revision ?? 1))
    .replaceAll(
      "{{RESPONDS}}",
      options.responds ? `,\n  "respondsToRequestId": "${options.responds}"` : "",
    );
}

async function install(page: Page, rig: Rig): Promise<void> {
  const session = () =>
    makeWorkingSession({
      id: SESSION_ID,
      state: rig.sessionState,
      artifacts: rig.artifacts(),
      queuedMessages: { messages: rig.queued, awaitingPrompt: false },
    });
  await mockSessions(page, () => [session()]);
  await page.route(`**/api/sessions/${SESSION_ID}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session()),
    });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/conversation`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: rig.messages,
        entries: rig.messages.map((message) => ({ kind: "message", ...message })),
        durationMs: 0,
        state: rig.sessionState,
      }),
    });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/artifacts/**`, (route) => {
    const name = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
    );
    const file = rig.files.get(name);
    void route.fulfill(
      file
        ? {
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: { "cache-control": "no-store" },
            body: file.html,
          }
        : {
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: "Not found" }),
          },
    );
  });
  await page.route(`**/api/sessions/${SESSION_ID}/send`, (route) => {
    const raw = route.request().postData() ?? "";
    rig.posts.push({ raw, body: JSON.parse(raw) as Post["body"] });
    void route.fulfill({
      status: rig.sendStatus,
      contentType: "application/json",
      body: JSON.stringify(rig.sendStatus < 300 ? { ok: true } : { error: "mock failure" }),
    });
  });
}

async function open(page: Page, rig: Rig): Promise<void> {
  await install(page, rig);
  await page.goto(`/sessions/${SESSION_ID}`);
}

function frameOf(page: Page, title: string) {
  return page.frameLocator(`iframe[title="${title}"]`);
}

function iframeLocator(page: Page, title: string) {
  return page.locator(`iframe[title="${title}"]`);
}

async function activeIsIframe(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.tagName === "IFRAME");
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
}

function requestIdOf(post: Post): string {
  const parsed = parseSnippetActionPrompt(post.body.message);
  if (!parsed) throw new Error("POST message is not a snippet action prompt");
  return parsed.requestId;
}

function expectedPrompt(
  post: Post,
  fields: Omit<SnippetPromptFields, "requestId" | "sessionId">,
): string {
  return buildSnippetActionPrompt({
    ...fields,
    requestId: requestIdOf(post),
    sessionId: SESSION_ID,
  });
}

const PICKER_TITLE = "Text variants";
const PICKER_INSTANCE = "inst-candidate-picker-0001".slice(0, 24);
const STATUS = (page: Page) => page.locator("[data-snippet-status]");

async function selectSpan(page: Page, sourceId: string, from: number, to: number): Promise<void> {
  await frameOf(page, PICKER_TITLE)
    .locator(`spur-selectable-text[source-id="${sourceId}"]`)
    .evaluate(
      (node, [start, end]) => {
        const text = node.firstChild as Text;
        const range = document.createRange();
        range.setStart(text, start as number);
        range.setEnd(text, end as number);
        const selection = document.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [from, to],
    );
}

// Screens are named dark; the light-theme test stores its own theme.
test.use({ colorScheme: "dark" });

test.describe("snippets: example flow", () => {
  test.setTimeout(150_000);

  test("candidate picker: choose, regenerate with instruction, modify selected span", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await expect(picker.locator("spur-choice")).toHaveCount(10);
    await expect(page.getByRole("heading", { name: /^Snippets/ })).toBeVisible();
    await shot(page, "S1-desktop-dark");

    // 1. choose two variants with real clicks
    await picker.locator('spur-choice[value="v02"]').click();
    await picker.locator('spur-choice[value="v05"]').click();
    await picker.getByRole("button", { name: "Choose selected" }).click();
    await expect.poll(() => rig.posts.length).toBe(1);
    const [choose] = rig.posts;
    expect(Object.keys(choose?.body ?? {}).sort()).toEqual(["message", "queue"]);
    expect(choose?.body.queue).toBe(true);
    expect(choose?.body.message).toBe(
      expectedPrompt(choose as Post, {
        snippetId: "candidate-picker",
        instanceId: PICKER_INSTANCE,
        revision: 1,
        actionId: "choose",
        label: "Choose selected",
        payload: { selected: ["v02", "v05"] },
      }),
    );
    await expect(STATUS(page)).toContainText("Sent");
    // every library control is disabled while the action is in flight
    await expect(picker.locator("spur-choice-list")).toHaveAttribute("disabled", "");
    await expect(picker.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    await shot(page, "S2-desktop-dark");

    // queue shows it, then the agent answers with revision 2
    rig.queued = [choose?.body.message ?? ""];
    await expect(STATUS(page)).toContainText("Queued", { timeout: 15_000 });
    await expect(page.locator("[data-snippet-action-summary]").first()).toHaveText(
      "Snippet action Choose selected · candidate-picker r1",
    );
    rig.queued = [];
    rig.publishFixture("candidate-picker", {
      instance: PICKER_INSTANCE,
      revision: 2,
      responds: requestIdOf(choose as Post),
    });
    await expect(STATUS(page)).toContainText("Done", { timeout: 15_000 });
    await expect(iframeLocator(page, PICKER_TITLE)).toBeVisible();
    await expect(picker.getByRole("button", { name: "Regenerate" })).toBeEnabled();

    // 2. regenerate with an instruction; the selection carries over the revision swap
    await expect(picker.locator('spur-choice[value="v02"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await picker.locator("textarea").fill("shorter");
    await picker.getByRole("button", { name: "Regenerate" }).click();
    await expect.poll(() => rig.posts.length).toBe(2);
    const regenerate = rig.posts[1] as Post;
    expect(regenerate.body.message).toBe(
      expectedPrompt(regenerate, {
        snippetId: "candidate-picker",
        instanceId: PICKER_INSTANCE,
        revision: 2,
        actionId: "regenerate",
        label: "Regenerate",
        payload: { selected: ["v02", "v05"], instruction: "shorter" },
      }),
    );
    rig.publishFixture("candidate-picker", {
      instance: PICKER_INSTANCE,
      revision: 3,
      responds: requestIdOf(regenerate),
    });
    await expect(STATUS(page)).toContainText("Done", { timeout: 15_000 });

    // 3. select a span in variant 6 and modify it. A real click first puts focus
    // in the iframe, so the toolbar click passes the interaction gate.
    await picker.locator("textarea").click();
    await selectSpan(page, "v06", 0, 25);
    await expect(picker.locator("spur-selection-toolbar")).toHaveAttribute("data-visible", "");
    await expect(picker.locator("spur-selection-toolbar")).toContainText("25 chars");
    await shot(page, "S1-desktop-dark-selection");
    await picker.getByRole("button", { name: "Modify selection" }).click();
    await expect.poll(() => rig.posts.length).toBe(3);
    const modify = rig.posts[2] as Post;
    const text = "Start with the boring part, it pays off later.";
    expect(modify.body.message).toBe(
      expectedPrompt(modify, {
        snippetId: "candidate-picker",
        instanceId: PICKER_INSTANCE,
        revision: 3,
        actionId: "modify-selection",
        label: "Modify selection",
        payload: {
          selection: { sourceId: "v06", text, start: 0, end: 25, quote: text.slice(0, 25) },
        },
      }),
    );
  });

  test("a real click inside the iframe sends exactly one POST without a confirm", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await picker.locator('spur-choice[value="v01"]').click();
    await picker.getByRole("button", { name: "Choose selected" }).click();
    await expect.poll(() => rig.posts.length).toBe(1);
    await expect(page.getByLabel("Confirm snippet action")).toHaveCount(0);
    expect(await activeIsIframe(page)).toBe(true);
  });

  test("focus already inside the iframe passes G2 through the hasFocus path", async ({ page }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await expect(picker.locator("spur-choice")).toHaveCount(10);
    await picker.locator("textarea").focus();
    expect(await activeIsIframe(page)).toBe(true);
    await picker.locator('spur-choice[value="v03"]').dispatchEvent("click");
    await picker.getByRole("button", { name: "Choose selected" }).dispatchEvent("click");
    await expect.poll(() => rig.posts.length).toBe(1);
    await expect(page.getByLabel("Confirm snippet action")).toHaveCount(0);
  });

  test("an undeclared action and an invalid payload are rejected with zero POSTs", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await expect(picker.locator("spur-choice")).toHaveCount(10);
    await picker.locator("textarea").focus();

    const unknown = await picker
      .locator("body")
      .evaluate(() =>
        (
          window as unknown as { spur: { invoke: (a: string, p: object) => Promise<unknown> } }
        ).spur.invoke("nope", {}),
      );
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_action" });
    await expect(picker.locator("spur-status")).toContainText("Unknown action.");

    const invalid = await picker.locator("body").evaluate(() =>
      (
        window as unknown as { spur: { invoke: (a: string, p: object) => Promise<unknown> } }
      ).spur.invoke("choose", {
        selected: 5,
        instruction: "x".repeat(10),
        extra: true,
      }),
    );
    expect(invalid).toMatchObject({ ok: false, reason: "invalid_payload" });
    await expect(picker.locator("spur-status")).toContainText("/selected wrong type");
    await expect(picker.locator("spur-status")).toContainText("/extra unknown property");
    await shot(page, "S6-desktop-dark");
    expect(rig.posts).toHaveLength(0);
    await expect(STATUS(page)).toHaveCount(0);
  });
});

test.describe("snippets: abuse gates", () => {
  test.setTimeout(120_000);

  // AC9: Chromium lets iframe code call window.focus() without a gesture, so
  // the interaction gate can pass for a hostile snippet. The result is recorded
  // in the report; the bound that holds either way is one unconfirmed send per
  // revision and 10 per session before every send needs a host confirm.
  test("records whether iframe-side focus() on load passes the interaction gate (AC9)", async ({
    page,
  }, testInfo) => {
    const rig = new Rig();
    rig.publishFixture("focus-steal", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Focus steal");
    await expect(frame.locator("body")).toHaveAttribute("data-focus-probe", /true|false/);
    await expect(async () => {
      const settled =
        rig.posts.length > 0 || (await page.getByLabel("Confirm snippet action").count()) > 0;
      expect(settled).toBe(true);
    }).toPass();
    const outcome = {
      documentHasFocusInFrame: await frame.locator("body").getAttribute("data-focus-probe"),
      iframeIsActiveElement: await activeIsIframe(page),
      postsWithoutClick: rig.posts.length,
      confirmShown: (await page.getByLabel("Confirm snippet action").count()) > 0,
    };
    testInfo.annotations.push({
      type: "ac9-iframe-focus-on-load",
      description: JSON.stringify(outcome),
    });
    expect(rig.posts.length).toBeLessThanOrEqual(1);
    expect(outcome.confirmShown).toBe(rig.posts.length === 0);
  });

  test("an auto-invoking snippet never dispatches across mount, revision swap and fullscreen", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("auto-invoke", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Auto invoke");
    await expect(frame.locator("#note")).toBeVisible();
    const strip = page.getByLabel("Confirm snippet action");
    await expect(strip).toContainText("Snippet started this action without a click inside it.");
    await shot(page, "S3-desktop-dark");

    expect(await activeIsIframe(page)).toBe(false);
    expect(rig.posts).toHaveLength(0);

    for (const revision of [2, 3]) {
      rig.publishFixture("auto-invoke", { revision });
      await expect(page.getByText(`auto-invoke · r${revision}`, { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(strip).toBeVisible();
      expect(await activeIsIframe(page)).toBe(false);
    }

    const toggle = page.getByRole("button", { name: "Open Auto invoke fullscreen" });
    await toggle.click();
    await expect(page.locator("dialog.snippet-dialog")).toHaveJSProperty("open", true);
    expect(await activeIsIframe(page)).toBe(false);
    await page.getByRole("button", { name: "Exit fullscreen" }).click();
    expect(await activeIsIframe(page)).toBe(false);
    expect(rig.posts).toHaveLength(0);
  });

  test("Discard resolves the snippet's invoke as declined; a trusted Send posts once", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("auto-invoke", { revision: 1 });
    await open(page, rig);
    const strip = page.getByLabel("Confirm snippet action");
    await expect(strip).toBeVisible();
    await strip.getByRole("button", { name: "Discard" }).click();
    await expect(strip).toHaveCount(0);
    expect(rig.posts).toHaveLength(0);
    // a new revision invokes again; this time Send is clicked
    rig.publishFixture("auto-invoke", { revision: 2 });
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await strip.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => rig.posts.length).toBe(1);
    await expect(STATUS(page)).toContainText("Sent");
  });

  test("the sandbox blocks fetch, form submit, parent access and storage; the font loads without a snippet request", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("probe", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Sandbox probe");
    await expect(frame.locator("body")).toHaveAttribute("data-probe-fetch", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-probe-parent", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-probe-storage", "blocked");

    await frame.locator("#submit").click();
    await expect(frame.locator("body")).toHaveAttribute("data-probe-submit", "clicked");
    // The sandbox (no allow-forms) and form-action 'none' both stop the submit:
    // the document stays, no navigation, no request (the route guard would fail the test).
    await page.waitForTimeout(500);
    await expect(frame.locator("#submit")).toBeVisible();
    await expect(frame.locator("body")).toHaveAttribute("data-probe-fetch", "blocked");

    // The first mount can connect before the host's font fetch settles (connect
    // never waits on fonts). A later revision mounts with the fonts cached.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.includes("JetBrainsMono")).length,
        ),
      )
      .toBeGreaterThanOrEqual(2);
    rig.publishFixture("probe", { revision: 2 });
    await expect(page.getByText("probe · r2", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(frame.locator("body")).toHaveAttribute("data-probe-font", "true", {
      timeout: 15_000,
    });
  });

  test("a second iframe load tears the panel down; Reload mounts a new iframe with zero POSTs", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("navigate", { revision: 1 });
    await open(page, rig);
    await expect(page.getByText("Navigated", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Snippet left its page. Panel stopped.")).toBeVisible();
    await shot(page, "S7-desktop-dark");
    await expect(iframeLocator(page, "Navigates away")).toHaveCount(0);
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(iframeLocator(page, "Navigates away")).toBeAttached();
    expect(rig.posts).toHaveLength(0);
  });

  test("an equal-revision change in place blocks actions until a higher revision", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await expect(picker.locator("spur-choice")).toHaveCount(10);
    await expect(picker.getByRole("button", { name: "Choose selected" })).toBeEnabled();

    rig.publish(
      "candidate-picker",
      fixtureHtml("candidate-picker", { instance: PICKER_INSTANCE }).replace(
        "Fewer words",
        "Changed words",
      ),
    );
    await expect(page.getByText("Revision conflict")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alert").filter({ hasText: "changed in place" })).toContainText(
      "Actions blocked until revision 2.",
    );
    await expect(picker.getByRole("button", { name: "Choose selected" })).toBeDisabled();
    await expect(picker.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    await expect(picker.locator("spur-choice").first()).toHaveAttribute("disabled", "");
    await expect(picker.getByText("Fewer words, same meaning.")).toBeVisible();
    await shot(page, "S7-desktop-dark-conflict");
    expect(rig.posts).toHaveLength(0);

    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE, revision: 2 });
    await expect(page.getByText("Revision conflict")).toHaveCount(0, { timeout: 15_000 });
    await expect(picker.getByRole("button", { name: "Choose selected" })).toBeEnabled();
  });
});

test.describe("snippets: failure states", () => {
  test.setTimeout(90_000);

  test("a 4xx shows Send failed with HTTP status and a host Retry that sends once more", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.sendStatus = 409;
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await picker.locator('spur-choice[value="v01"]').click();
    await picker.getByRole("button", { name: "Choose selected" }).click();
    await expect(STATUS(page)).toContainText("Send failed · HTTP 409");
    await expect(page.locator('[data-snippet-status="error"]')).toHaveAttribute("role", "alert");
    await expect(picker.locator("spur-status")).toContainText("Send failed · HTTP 409");
    await shot(page, "S4-desktop-dark");
    rig.sendStatus = 200;
    await page.getByRole("button", { name: "Retry" }).first().click();
    await expect.poll(() => rig.posts.length).toBe(2);
    const retried = parseSnippetActionPrompt(rig.posts[1]?.body.message ?? "");
    expect(retried?.retryOf).toBe(requestIdOf(rig.posts[0] as Post));
    expect(retried?.requestId).not.toBe(retried?.retryOf);
  });

  test("a 502 reads Delivery unknown with Retry", async ({ page }) => {
    const rig = new Rig();
    rig.sendStatus = 502;
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await picker.locator('spur-choice[value="v01"]').click();
    await picker.getByRole("button", { name: "Choose selected" }).click();
    await expect(STATUS(page)).toContainText("Delivery unknown");
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await shot(page, "S5-desktop-dark");
  });

  test("snippet files over 256 KiB and invalid manifests become error cards", async ({ page }) => {
    const rig = new Rig();
    rig.publish(
      "huge",
      `<script type="application/spur-snippet+json">{}</script>${"x".repeat(300 * 1024)}`,
    );
    rig.publish("broken", `<script type="application/spur-snippet+json">{"nope":1}</script>`);
    await open(page, rig);
    await expect(page.getByText("Too large")).toBeVisible();
    await expect(page.getByText("File over 256 KiB. Not loaded.")).toBeVisible();
    await expect(page.getByText("Manifest invalid")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
    await shot(page, "S7-desktop-dark-cards");
  });

  test("five owned files mount four panels and list the rest", async ({ page }) => {
    const rig = new Rig();
    for (const id of ["a", "b", "c", "d", "e"]) {
      rig.publish(
        id,
        fixtureHtml("resizable", { instance: `inst-${id}-0000001` }).replaceAll(
          '"snippetId": "resizable"',
          `"snippetId": "${id}"`,
        ),
      );
    }
    await open(page, rig);
    await expect(page.locator("[data-snippet-panel]")).toHaveCount(4, { timeout: 15_000 });
    await expect(page.getByText("Not mounted · limit 4")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Snippets/ })).toContainText("5");
    await shot(page, "S9-desktop-dark");
  });
});

test.describe("snippets: fullscreen", () => {
  test.setTimeout(90_000);

  test("fullscreen keeps one document and typed text; Escape inside the iframe exits to the toggle", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("resizable", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Resizable");
    await expect(frame.locator("body")).toHaveAttribute("data-ready", "1");
    await frame.locator("input").fill("typed before fullscreen");
    const frameCount = page.frames().length;

    const toggle = page.getByRole("button", { name: "Open Resizable fullscreen" });
    await toggle.click();
    const dialog = page.locator("dialog.snippet-dialog");
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeFocused();
    await expect(frame.locator("input")).toHaveValue("typed before fullscreen");
    expect(page.frames().length).toBe(frameCount);
    expect(await activeIsIframe(page)).toBe(false);
    await shot(page, "S8-desktop-dark");

    // Escape pressed inside the iframe is forwarded to the host
    await frame.locator("input").click();
    await frame.locator("input").press("Escape");
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(false);
    await expect(toggle).toBeFocused();
    await expect(frame.locator("input")).toHaveValue("typed before fullscreen");
    await expect(iframeLocator(page, "Resizable")).toBeVisible();
    expect(rig.posts).toHaveLength(0);
  });

  test("native Escape and the close button exit as well", async ({ page }) => {
    const rig = new Rig();
    rig.publishFixture("resizable", { revision: 1 });
    await open(page, rig);
    const dialog = page.locator("dialog.snippet-dialog");
    const toggle = page.getByRole("button", { name: "Open Resizable fullscreen" });
    await expect(iframeLocator(page, "Resizable")).toBeVisible();
    await toggle.click();
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(false);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(false);
    await expect(toggle).toBeFocused();
  });

  test("SDK-triggered fullscreen after a click inside the iframe: focus never lands in the iframe and Escape returns it to the toggle", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("resizable", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Resizable");
    await expect(frame.locator("body")).toHaveAttribute("data-ready", "1");
    await frame.locator("#block").click();
    const dialog = page.locator("dialog.snippet-dialog");
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
    await expect(frame.locator("body")).toHaveAttribute("data-fs-granted", "true");
    expect(await activeIsIframe(page)).toBe(false);
    await frame.locator("input").click();
    await frame.locator("input").press("Escape");
    await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(false);
    await expect(page.getByRole("button", { name: "Open Resizable fullscreen" })).toBeFocused();
    await expect(dialog).toBeVisible();
  });

  test("an SDK fullscreen request without a click is refused", async ({ page }) => {
    const rig = new Rig();
    rig.publishFixture("resizable", { revision: 1 });
    await open(page, rig);
    const frame = frameOf(page, "Resizable");
    await expect(frame.locator("body")).toHaveAttribute("data-ready", "1");
    const granted = await frame
      .locator("body")
      .evaluate(() =>
        (
          window as unknown as { spur: { requestFullscreen: () => Promise<boolean> } }
        ).spur.requestFullscreen(),
      );
    expect(granted).toBe(false);
    expect(
      await page.locator("dialog.snippet-dialog").evaluate((node) => node.matches(":modal")),
    ).toBe(false);
  });

  test("the iframe follows its content: 600 px shrinks to 300 px", async ({ page }) => {
    const rig = new Rig();
    rig.publishFixture("resizable", { revision: 1 });
    await open(page, rig);
    const frame = iframeLocator(page, "Resizable");
    await expect(frame).toBeVisible();
    await expect
      .poll(async () => (await frame.boundingBox())?.height ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(600);
    const tall = (await frame.boundingBox())?.height ?? 0;
    await frameOf(page, "Resizable")
      .locator("#block")
      .evaluate((node) => {
        node.style.height = "300px";
      });
    await expect
      .poll(async () => (await frame.boundingBox())?.height ?? Number.POSITIVE_INFINITY, {
        timeout: 15_000,
      })
      .toBeLessThan(tall - 200);
  });
});

test.describe("snippets: revision, state and chat summary", () => {
  test.setTimeout(90_000);

  test("a higher revision replaces the document and carries control state; a new instance resets it", async ({
    page,
  }) => {
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    const picker = frameOf(page, PICKER_TITLE);
    await picker.locator("textarea").fill("keep me");
    await picker.locator('spur-choice[value="v04"]').click();
    // state flushes on a 500 ms trailing window
    await page.waitForTimeout(800);
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE, revision: 2 });
    await expect(page.getByText("candidate-picker · r2", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(picker.locator("textarea")).toHaveValue("keep me");
    await expect(picker.locator('spur-choice[value="v04"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );

    rig.publishFixture("candidate-picker", { instance: "inst-picker-fresh-02", revision: 1 });
    await expect(picker.locator("textarea")).toHaveValue("", { timeout: 15_000 });
    await expect(picker.locator('spur-choice[value="v04"]')).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  test("queued and conversation snippet prompts render as compact summaries with a closed raw prompt", async ({
    page,
  }) => {
    const prompt = buildSnippetActionPrompt({
      requestId: "11111111-2222-3333-4444-555555555555",
      sessionId: SESSION_ID,
      snippetId: "candidate-picker",
      instanceId: PICKER_INSTANCE,
      revision: 3,
      actionId: "regenerate",
      label: "Regenerate",
      payload: { instruction: "shorter" },
    });
    const rig = new Rig();
    rig.queued = [prompt, "plain follow-up"];
    rig.messages = [
      { role: "user", text: prompt, timestampMs: 1 },
      { role: "assistant", text: "On it.", timestampMs: 2 },
    ];
    await open(page, rig);
    const summaries = page.locator("[data-snippet-action-summary]");
    await expect(summaries).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(summaries.nth(index)).toHaveText(
        "Snippet action Regenerate · candidate-picker r3",
      );
    }
    await expect(page.getByText("plain follow-up")).toBeVisible();
    const details = page.locator("details", { hasText: "Raw prompt" });
    await expect(details).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(details.nth(index)).not.toHaveAttribute("open", "");
    }
    await details.nth(1).locator("summary").click();
    await expect(details.nth(1).locator("pre")).toHaveText(prompt);
    await shot(page, "S10-desktop-dark");
  });
});

test.describe("snippets: light theme and mobile", () => {
  test.setTimeout(90_000);

  test("light theme renders from the light token block", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("spur:theme", "light"));
    const rig = new Rig();
    rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
    await open(page, rig);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const picker = frameOf(page, PICKER_TITLE);
    await expect(picker.locator("spur-choice")).toHaveCount(10);
    const hostAccent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim(),
    );
    const frameAccent = await picker
      .locator("html")
      .evaluate((node) => getComputedStyle(node).getPropertyValue("--spur-accent").trim());
    expect(frameAccent).toBe(hostAccent);
    await shot(page, "S1-desktop-light");
  });

  test.describe("mobile 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    async function noHorizontalScroll(page: Page): Promise<void> {
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    }

    test("idle panel, confirm strip and fullscreen fit the viewport", async ({ page }) => {
      const rig = new Rig();
      rig.publishFixture("auto-invoke", { revision: 1 });
      rig.publishFixture("candidate-picker", { instance: PICKER_INSTANCE });
      await open(page, rig);
      const picker = frameOf(page, PICKER_TITLE);
      await expect(picker.locator("spur-choice")).toHaveCount(10);
      await noHorizontalScroll(page);
      await shot(page, "S1-mobile-dark");

      // S3: the auto-invoking snippet leaves a pending confirm
      const strip = page.getByLabel("Confirm snippet action");
      await expect(strip).toBeVisible();
      await noHorizontalScroll(page);
      const discard = await strip.getByRole("button", { name: "Discard" }).boundingBox();
      const send = await strip.getByRole("button", { name: "Send" }).boundingBox();
      expect(Math.abs((discard?.width ?? 0) - (send?.width ?? 1))).toBeLessThanOrEqual(1);
      await shot(page, "S3-mobile-dark");

      // S8: fullscreen keeps strip and status line below the iframe, inside the viewport
      await page.getByRole("button", { name: "Open Auto invoke fullscreen" }).click();
      const dialog = page.locator("dialog.snippet-dialog").filter({ has: strip });
      await expect.poll(() => dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
      const frame = await iframeLocator(page, "Auto invoke").boundingBox();
      const stripBox = await strip.boundingBox();
      const statusBox = await dialog.locator("[data-snippet-status]").boundingBox();
      const viewport = page.viewportSize();
      expect(frame && stripBox && statusBox && viewport).toBeTruthy();
      expect(stripBox!.y).toBeGreaterThanOrEqual(frame!.y + frame!.height - 1);
      expect(statusBox!.y).toBeGreaterThanOrEqual(stripBox!.y + stripBox!.height - 1);
      expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(viewport!.height);
      expect(stripBox!.x + stripBox!.width).toBeLessThanOrEqual(viewport!.width);
      await noHorizontalScroll(page);
      await shot(page, "S8-mobile-dark");
    });

    test("compact summary fits the viewport", async ({ page }) => {
      const prompt = buildSnippetActionPrompt({
        requestId: "11111111-2222-3333-4444-555555555555",
        sessionId: SESSION_ID,
        snippetId: "candidate-picker",
        instanceId: PICKER_INSTANCE,
        revision: 3,
        actionId: "regenerate",
        label: "Regenerate",
        payload: { instruction: "shorter" },
      });
      const rig = new Rig();
      rig.queued = [prompt];
      rig.messages = [{ role: "user", text: prompt, timestampMs: 1 }];
      await open(page, rig);
      await expect(page.locator("[data-snippet-action-summary]")).toHaveCount(2);
      await noHorizontalScroll(page);
      await shot(page, "S10-mobile-dark");
    });
  });
});
