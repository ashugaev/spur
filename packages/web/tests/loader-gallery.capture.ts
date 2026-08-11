import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "playwright/test";
import { makeWorkingSession, mockSessions } from "./fixtures.js";

const artifactsDir = process.env.SPUR_SESSION_ARTIFACTS_DIR;
if (process.env.SPUR_LOADER_CAPTURE !== "1" || !artifactsDir) {
  throw new Error(
    "Loader capture requires SPUR_LOADER_CAPTURE=1 and SPUR_SESSION_ARTIFACTS_DIR.",
  );
}

const galleryDir = join(artifactsDir, "loaders");
const imageDir = join(galleryDir, "images");
const videoDir = join(galleryDir, "videos");
const entries: Array<{ name: string; surface: string; image: string; video: string }> = [];
const expectedScenarioCount = 8;

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
  await page.waitForTimeout(1_600);
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
  expect(entries).toHaveLength(expectedScenarioCount);
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
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
