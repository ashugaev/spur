import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "playwright/test";
import { makeWorkingSession, mockSessions } from "./fixtures.js";

const artifactsDir = process.env.SPUR_SESSION_ARTIFACTS_DIR;
if (process.env.SPUR_LOADER_CAPTURE !== "1" || !artifactsDir) {
  throw new Error("Loader capture requires SPUR_LOADER_CAPTURE=1 and SPUR_SESSION_ARTIFACTS_DIR.");
}

const galleryDir = join(artifactsDir, "loaders");
const imageDir = join(galleryDir, "images");
const videoDir = join(galleryDir, "videos");
const entries: Array<{ name: string; surface: string; image: string; video: string }> = [];
const expectedScenarios = [
  "account-add-spinner",
  "answer-spinner",
  "artifact-copy-spinner",
  "artifact-lightbox-skeleton",
  "artifact-tile-skeletons",
  "backend-connection-indicator",
  "dashboard-centered",
  "dashboard-centered-reduced-mobile",
  "dashboard-project-action-spinner",
  "model-list-skeleton",
  "reduced-loading-bar",
  "reduced-skeleton",
  "session-action-spinner",
  "session-centered",
  "session-centered-mobile",
  "session-composer-spinners",
  "slash-suggestions-skeleton",
  "spawn-busy-spinner",
  "version-switch-loading-bar",
  "voice-starting-spinner",
] as const;

async function captureScenario({
  browser,
  name,
  surface,
  prepare,
  reducedMotion = "no-preference",
  viewport = { width: 1440, height: 900 },
}: {
  browser: Browser;
  name: string;
  surface: string;
  prepare: (page: Page) => Promise<void>;
  reducedMotion?: "no-preference" | "reduce";
  viewport?: { width: number; height: number };
}) {
  await mkdir(imageDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    recordVideo: { dir: test.info().outputPath("recordings"), size: viewport },
    reducedMotion,
    viewport,
  });
  const page = await context.newPage();
  await prepare(page);
  await page.waitForTimeout(1_000);
  const image = `images/${name}.png`;
  const video = `videos/${name}.webm`;
  await page.screenshot({ path: join(galleryDir, image), fullPage: true });
  const recording = page.video();
  await context.close();
  if (!recording) throw new Error(`Video recording did not start for ${name}.`);
  await recording.saveAs(join(galleryDir, video));
  entries.push({ name, surface, image, video });
}

async function mockSession(page: Page, session: ReturnType<typeof makeWorkingSession>) {
  await page.route(`**/api/sessions/${session.id}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
}

test.beforeAll(async () => {
  await mkdir(galleryDir, { recursive: true });
  await writeFile(join(galleryDir, "manifest.json"), "[]\n");
  await writeFile(join(galleryDir, "index.md"), "# Loader gallery\n\nCapture incomplete.\n");
});

test.afterAll(async () => {
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  expect(ordered.map((entry) => entry.name)).toEqual(expectedScenarios);
  await writeFile(join(galleryDir, "manifest.json"), `${JSON.stringify(ordered, null, 2)}\n`);
  const rows = ordered.map(
    ({ name, surface, image, video }) =>
      `| ${name} | ${surface} | [PNG](${image}) | [WebM](${video}) |`,
  );
  await writeFile(
    join(galleryDir, "index.md"),
    [
      "# Loader gallery",
      "",
      "| Scenario | Surface | Photo | Video |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
});

test("dashboard centered loader", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "dashboard-centered",
    surface: "Dashboard boot / CenteredLoader / animated",
    prepare: async (page) => {
      await page.route(/\/api\/sessions(\?.*)?$/, () => {});
      await page.goto("/");
      await expect(page.getByRole("status", { name: "Loading dashboard" })).toBeVisible();
    },
  });
});

test("dashboard centered loader reduced motion", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "dashboard-centered-reduced-mobile",
    surface: "Dashboard boot / CenteredLoader / reduced motion / mobile",
    reducedMotion: "reduce",
    viewport: { width: 390, height: 844 },
    prepare: async (page) => {
      await page.route(/\/api\/sessions(\?.*)?$/, () => {});
      await page.goto("/");
      const mark = page
        .getByRole("status", { name: "Loading dashboard" })
        .locator(".loader-centered-mark > span")
        .first();
      await expect(mark).toHaveCSS("animation-name", "none");
    },
  });
});

test("session centered loader", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "session-centered",
    surface: "Session detail boot / CenteredLoader / animated",
    prepare: async (page) => {
      await page.route("**/api/sessions/gallery-session", () => {});
      await page.goto("/sessions/gallery-session");
      await expect(page.getByRole("status", { name: "Loading session" })).toBeVisible();
    },
  });
});

test("session centered loader mobile", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "session-centered-mobile",
    surface: "Session detail boot / CenteredLoader / mobile",
    viewport: { width: 390, height: 844 },
    prepare: async (page) => {
      await page.route("**/api/sessions/gallery-session-mobile", () => {});
      await page.goto("/sessions/gallery-session-mobile");
      await expect(page.getByRole("status", { name: "Loading session" })).toBeVisible();
    },
  });
});

test("model list skeleton", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "model-list-skeleton",
    surface: "Spawn model list / Skeleton",
    prepare: async (page) => {
      await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
      await page.route("**/api/models?agent=claude", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: /spawn session/i }).click();
      await page.getByRole("button", { name: "Spawn model" }).click();
      await expect(page.getByRole("status", { name: "Loading models" })).toBeVisible();
    },
  });
});

test("slash suggestions skeleton", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "slash-suggestions-skeleton",
    surface: "Spawn slash suggestions / Skeleton",
    prepare: async (page) => {
      await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
      await page.route("**/api/projects/my-project/slash-commands?agent=claude", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: /spawn session/i }).click();
      await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
      await page.getByRole("button", { name: "Slash", exact: true }).click();
      await expect(page.getByRole("status", { name: "Loading suggestions" })).toBeVisible();
    },
  });
});

test("busy button spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "spawn-busy-spinner",
    surface: "Spawn submit action / Spinner",
    prepare: async (page) => {
      await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
      await page.route("**/api/preflight", (route) => {
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ branch: "feature/loader-gallery" }),
        });
      });
      await page.route("**/api/spawn", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: /spawn session/i }).click();
      await page.getByRole("combobox", { name: "Spawn project" }).selectOption("my-project");
      await page.getByRole("button", { name: "Spawn", exact: true }).click();
      await expect(page.getByRole("button", { name: "Spawning session" })).toBeVisible();
    },
  });
});

test("version switch loading bar", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "version-switch-loading-bar",
    surface: "Version switch blocking panel / LoadingBar",
    prepare: async (page) => {
      await mockSessions(page, []);
      await page.route("**/api/runtime/info", (route) => {
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ version: "1.4.0" }),
        });
      });
      await page.route("**/api/runtime/versions", (route) => {
        void route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            current: "1.4.0",
            available: [
              { tag: "1.5.0", publishedAt: "2026-08-11T00:00:00.000Z" },
              { tag: "1.4.0", publishedAt: "2026-08-01T00:00:00.000Z" },
            ],
          }),
        });
      });
      await page.route("**/api/runtime/versions/switch", (route) => {
        void route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ accepted: true, version: "1.5.0" }),
        });
      });
      await page.goto("/");
      const versionButton = page.getByRole("button", { name: /Show Spur version information/ });
      await expect(versionButton).toContainText("1.4.0");
      await versionButton.click();
      await page.getByRole("button", { name: "Switch Spur to 1.5.0" }).click();
      await page
        .getByRole("dialog", { name: "Switch Spur version" })
        .getByRole("button", { name: "Switch", exact: true })
        .click();
      await expect(page.getByRole("status", { name: "Updating Spur" })).toBeVisible();
    },
  });
});

test("reduced loading bar", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "reduced-loading-bar",
    surface: "Version switch panel / LoadingBar / reduced motion",
    reducedMotion: "reduce",
    prepare: async (page) => {
      await mockSessions(page, []);
      await page.route(
        "**/api/runtime/info",
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ version: "1.4.0" }),
          }),
      );
      await page.route(
        "**/api/runtime/versions",
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              current: "1.4.0",
              available: [{ tag: "1.5.0", publishedAt: "2026-08-11T00:00:00.000Z" }],
            }),
          }),
      );
      await page.route(
        "**/api/runtime/versions/switch",
        (route) =>
          void route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({ accepted: true, version: "1.5.0" }),
          }),
      );
      await page.goto("/");
      await page.getByRole("button", { name: /Show Spur version information/ }).click();
      await page.getByRole("button", { name: "Switch Spur to 1.5.0" }).click();
      await page
        .getByRole("dialog", { name: "Switch Spur version" })
        .getByRole("button", { name: "Switch", exact: true })
        .click();
      const bar = page.getByRole("status", { name: "Updating Spur" });
      await expect(bar.locator(".loader-bar-segment")).toHaveCSS("animation-name", "none");
    },
  });
});

test("reduced skeleton", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "reduced-skeleton",
    surface: "Model list / Skeleton / reduced motion",
    reducedMotion: "reduce",
    prepare: async (page) => {
      await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
      await page.route("**/api/models?agent=claude", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: /spawn session/i }).click();
      await page.getByRole("button", { name: "Spawn model" }).click();
      const skeleton = page.getByRole("status", { name: "Loading models" });
      await expect(skeleton).toHaveCSS("animation-name", "none");
      await expect(skeleton).toHaveCSS("background-image", "none");
    },
  });
});

test("artifact tile skeletons", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "artifact-tile-skeletons",
    surface: "Image, video, and HTML artifact tiles / Skeleton",
    prepare: async (page) => {
      const session = makeWorkingSession({
        id: "gallery-artifacts",
        artifacts: [
          {
            id: "image.png",
            name: "image.png",
            size: 1_024,
            mimeType: "image/png",
            kind: "image",
            origin: "intentional",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
          {
            id: "video.webm",
            name: "video.webm",
            size: 2_048,
            mimeType: "video/webm",
            kind: "video",
            origin: "intentional",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
          {
            id: "page.html",
            name: "page.html",
            size: 512,
            mimeType: "text/html",
            kind: "text",
            origin: "intentional",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      });
      await mockSession(page, session);
      await page.route(`**/api/sessions/${session.id}/artifacts/*`, () => {});
      await page.goto(`/sessions/${session.id}`);
      await expect(page.getByRole("status", { name: /Loading preview for/ })).toHaveCount(3);
    },
  });
});

test("artifact lightbox skeleton", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "artifact-lightbox-skeleton",
    surface: "Artifact lightbox / Skeleton",
    prepare: async (page) => {
      const session = makeWorkingSession({
        id: "gallery-lightbox",
        artifacts: [
          {
            id: "image.png",
            name: "image.png",
            size: 1_024,
            mimeType: "image/png",
            kind: "image",
            origin: "intentional",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      });
      await mockSession(page, session);
      await page.route(`**/api/sessions/${session.id}/artifacts/*`, () => {});
      await page.goto(`/sessions/${session.id}`);
      await page.getByRole("button", { name: "Preview image.png" }).click({ force: true });
      const lightbox = page.getByRole("dialog", { name: "Artifact preview image.png" });
      await expect(lightbox).toBeVisible();
      await expect(
        lightbox.getByRole("status", { name: "Loading preview for image.png" }),
      ).toBeVisible();
    },
  });
});

test("artifact copy spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "artifact-copy-spinner",
    surface: "Artifact lightbox copy action / Spinner",
    prepare: async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => new Promise<void>(() => {}) },
        });
      });
      const session = makeWorkingSession({
        id: "gallery-copy",
        artifacts: [
          {
            id: "notes.md",
            name: "notes.md",
            size: 128,
            mimeType: "text/markdown",
            kind: "text",
            origin: "intentional",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      });
      await mockSession(page, session);
      await page.route(
        `**/api/sessions/${session.id}/artifacts/notes.md`,
        (route) =>
          void route.fulfill({ status: 200, contentType: "text/markdown", body: "# Notes" }),
      );
      await page.goto(`/sessions/${session.id}`);
      await page.getByRole("button", { name: "Preview notes.md" }).click({ force: true });
      const copy = page.getByRole("button", { name: "Copy notes.md" });
      await expect(copy).toBeVisible();
      await copy.click();
      await expect(page.getByRole("button", { name: "Copying notes.md" })).toBeVisible();
    },
  });
});

test("dashboard project action spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "dashboard-project-action-spinner",
    surface: "Dashboard project create/save/delete actions / Spinner",
    prepare: async (page) => {
      await mockSessions(page, []);
      await page.route("**/api/projects", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: "All Projects" }).click();
      await page.getByRole("menuitem", { name: "+ New project" }).click();
      await page.getByRole("textbox", { name: "Display name" }).fill("Gallery");
      await page.getByRole("textbox", { name: "Session prefix" }).fill("gallery");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("button", { name: "Creating project" })).toBeVisible();
    },
  });
});

test("session action spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "session-action-spinner",
    surface: "Session lifecycle actions / Spinner",
    prepare: async (page) => {
      const session = makeWorkingSession({ id: "gallery-action" });
      await mockSession(page, session);
      await page.route(`**/api/sessions/${session.id}/pause`, () => {});
      await page.goto(`/sessions/${session.id}`);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pausing session" })).toBeVisible();
    },
  });
});

test("session composer spinners", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "session-composer-spinners",
    surface: "Session queue/send composer actions / Spinner",
    prepare: async (page) => {
      const session = makeWorkingSession({ id: "gallery-composer" });
      await mockSession(page, session);
      await page.route(`**/api/sessions/${session.id}/send`, () => {});
      await page.goto(`/sessions/${session.id}`);
      await page.getByRole("textbox", { name: "Message..." }).fill("Keep going");
      await page.getByRole("button", { name: /Send now/ }).click();
      await expect(page.getByRole("button", { name: "Sending message" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Queueing message" })).toBeVisible();
    },
  });
});

test("voice starting spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "voice-starting-spinner",
    surface: "Voice microphone start/transcribe states / Spinner",
    prepare: async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: () => new Promise<MediaStream>(() => {}) },
        });
      });
      await mockSessions(page, [], [{ id: "my-project", name: "my-project" }]);
      await page.goto("/");
      await page.getByRole("button", { name: /spawn session/i }).click();
      await page
        .getByRole("dialog", { name: "Spawn Session" })
        .getByRole("button", { name: "Start voice recording" })
        .click();
      await expect(page.getByRole("status", { name: "Starting microphone" })).toBeVisible();
    },
  });
});

test("account add spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "account-add-spinner",
    surface: "Account and confirmation-dialog actions / Spinner",
    prepare: async (page) => {
      await mockSessions(page, []);
      await page.route(
        "/api/claude-accounts",
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ accounts: [] }),
          }),
      );
      await page.route("/api/claude-accounts/add", () => {});
      await page.goto("/");
      await page.getByRole("button", { name: "Manage Claude accounts" }).click();
      await page.getByTestId("add-account").click();
      await expect(page.getByRole("button", { name: "Adding account" })).toBeVisible();
    },
  });
});

test("answer spinner", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "answer-spinner",
    surface: "Inline question answer / Spinner",
    prepare: async (page) => {
      const session = makeWorkingSession({ id: "gallery-answer", state: "waiting" });
      await mockSession(page, session);
      await page.route(
        `**/api/sessions/${session.id}/conversation`,
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              entries: [
                {
                  kind: "question",
                  header: "Confirm action",
                  prompt: "Continue?",
                  options: [
                    { label: "Yes", index: 1 },
                    { label: "No", index: 2 },
                  ],
                  timestampMs: 1,
                },
              ],
              messages: [],
              durationMs: 0,
            }),
          }),
      );
      await page.route(`**/api/sessions/${session.id}/answer`, () => {});
      await page.goto(`/sessions/${session.id}`);
      await page.getByRole("button", { name: /Yes/ }).click();
      await expect(page.getByRole("status", { name: "Sending answer" })).toBeVisible();
    },
  });
});

test("backend connection indicator", async ({ browser }) => {
  await captureScenario({
    browser,
    name: "backend-connection-indicator",
    surface: "Preserved terminal connection indicator / pulse plus explanatory title",
    prepare: async (page) => {
      await page.addInitScript(() => {
        class PendingWebSocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;
          readyState = PendingWebSocket.CONNECTING;
          binaryType: BinaryType = "blob";
          bufferedAmount = 0;
          extensions = "";
          protocol = "";
          url: string;
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          constructor(url: string | URL) {
            this.url = String(url);
          }
          send() {}
          close() {}
          addEventListener() {}
          removeEventListener() {}
          dispatchEvent() {
            return true;
          }
        }
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          writable: true,
          value: PendingWebSocket,
        });
      });
      const session = makeWorkingSession({ id: "gallery-connection" });
      await mockSessions(page, [session]);
      await page.goto("/");
      await page.getByRole("button", { name: `Open web terminal for ${session.id}` }).click();
      await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
        "data-ws-status",
        "connecting",
      );
      await expect(page.getByTestId("direct-terminal-header-status-dot")).toHaveAttribute(
        "title",
        "Connecting…",
      );
    },
  });
});
