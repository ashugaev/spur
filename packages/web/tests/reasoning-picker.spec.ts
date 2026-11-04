import {
  test,
  expect,
  type Page,
  makeWorkingSession,
  makeCompletedSession,
  mockSessions,
} from "./fixtures.js";
import type { AgentName } from "../src/lib/agents.js";
import type { ProviderReasoningEffort } from "../src/lib/types.js";

type Surface = "Spawn" | "Respawn" | "Desk spawn" | "Handoff";
const surfaces: Surface[] = ["Spawn", "Respawn", "Desk spawn", "Handoff"];
const agents: AgentName[] = ["claude", "codex", "cursor", "opencode"];
const levels: ProviderReasoningEffort[] = ["low", "medium", "high"];
const projects = [
  {
    id: "reasoning-project",
    name: "Reasoning project",
    configured: true,
    prefix: "reasoning",
    path: "/tmp/reasoning-project",
  },
  {
    id: "other-project",
    name: "Other project",
    configured: true,
    prefix: "other",
    path: "/tmp/other-project",
  },
];

function modelId(agent: AgentName) {
  return agent === "opencode" ? "provider/reasoning-model" : "reasoning-model";
}

async function catalog(page: Page, available: ProviderReasoningEffort[] = levels) {
  await page.route(/\/api\/models(\?.*)?$/, async (route) => {
    const agent = new URL(route.request().url()).searchParams.get("agent") as AgentName;
    await route.fulfill({
      json: {
        agent,
        defaultReasoningEfforts: available,
        models: [
          {
            id: modelId(agent),
            label: "Reasoning model",
            isDefault: true,
            reasoningEfforts: available,
          },
          { id: "unsupported-model", label: "Unsupported model", reasoningEfforts: [] },
        ],
      },
    });
  });
}

async function open(
  page: Page,
  surface: Surface,
  agent: AgentName = "claude",
  current?: ProviderReasoningEffort,
  capabilityError = false,
  chooseHandoffTarget = true,
) {
  const session = (surface === "Respawn" ? makeCompletedSession : makeWorkingSession)({
    id: "reasoning-source",
    project: "reasoning-project",
    agent,
    model: modelId(agent),
    reasoningEffort: current,
  });
  await mockSessions(page, [session], projects);
  await page.route("**/api/sessions/reasoning-source", (route) => route.fulfill({ json: session }));
  await catalog(page);
  if (capabilityError) {
    await page.route(/\/api\/models(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          agent,
          defaultReasoningEfforts: [],
          reasoningError: "Capabilities unavailable",
          models: [
            { id: modelId(agent), label: "Reasoning model", isDefault: true },
            { id: "other-model", label: "Other model" },
          ],
        },
      }),
    );
  }
  await page.route(/\/api\/projects\/[^/]+\/spawn-defaults(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        model: modelId(agent),
        worktree: true,
        reasoningEffort: route.request().url().includes("other-project") ? "low" : "high",
      },
    }),
  );
  await page.goto(surface === "Spawn" ? "/" : "/sessions/reasoning-source");
  const opener =
    surface === "Spawn"
      ? /^spawn session$/i
      : surface === "Respawn"
        ? /edit & respawn/i
        : surface === "Desk spawn"
          ? /^desk agent$/i
          : /^handoff$/i;
  await page.getByRole("button", { name: opener }).click();
  if (surface === "Spawn") {
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("reasoning-project");
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption(agent);
    await page.getByRole("textbox", { name: "Prompt...", exact: true }).fill("Verify reasoning");
  } else if (surface === "Desk spawn") {
    await page.getByRole("combobox", { name: "Desk spawn agent" }).selectOption(agent);
    await page.getByRole("textbox", { name: "Desk agent prompt" }).fill("Verify reasoning");
  } else if (surface === "Handoff" && chooseHandoffTarget) {
    await page.getByRole("combobox", { name: "Handoff agent" }).selectOption(agent);
  }
  const select = page.getByRole("combobox", { name: `${surface} reasoning` });
  await expect(select).toBeVisible();
  return select;
}

async function submit(page: Page, surface: Surface) {
  const endpoint =
    surface === "Respawn"
      ? "/api/sessions/reasoning-source/respawn"
      : surface === "Handoff"
        ? "/api/sessions/reasoning-source/handoff"
        : "/api/spawn";
  // Keep the form visible on a controlled failure; this test inspects browser
  // intent only. Proxy and native execution are verified by separate gates.
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({ status: 400, json: { error: "Captured browser request" } }),
  );
  const request = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === endpoint && candidate.method() === "POST",
  );
  const name =
    surface === "Respawn" ? /^respawn$/i : surface === "Handoff" ? /^handoff$/i : /^spawn$/i;
  const button = page.getByRole("dialog").getByRole("button", { name });
  await expect(button).toBeEnabled();
  await button.click();
  return (await request).postDataJSON() as Record<string, unknown>;
}

test.describe("Reasoning selector browser intent", () => {
  test("Handoff: initial different-agent target inherits Default without source carry", async ({
    page,
  }) => {
    const select = await open(page, "Handoff", "claude", "medium", false, false);
    await expect(page.getByRole("combobox", { name: "Handoff agent" })).toHaveValue("codex");
    await expect(select).toHaveValue("default");
    expect(await submit(page, "Handoff")).not.toHaveProperty("reasoningEffort");
  });
  for (const surface of surfaces) {
    test(`${surface}: success freezes reasoning until composer closes`, async ({ page }) => {
      const select = await open(page, surface);
      await select.selectOption("high");
      const endpoint =
        surface === "Respawn"
          ? "/api/sessions/reasoning-source/respawn"
          : surface === "Handoff"
            ? "/api/sessions/reasoning-source/handoff"
            : "/api/spawn";
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**${endpoint}`, async (route) => {
        await held;
        await route.fulfill({
          status: 201,
          json: makeWorkingSession({
            id: "reasoning-source",
            project: "reasoning-project",
            agent: "claude",
            model: modelId("claude"),
            reasoningEffort: "high",
          }),
        });
      });
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === endpoint && request.method() === "POST",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", {
          name:
            surface === "Respawn"
              ? /^respawn$/i
              : surface === "Handoff"
                ? /^handoff$/i
                : /^spawn$/i,
        })
        .click();
      expect((await requested).postDataJSON().reasoningEffort).toBe("high");
      await expect(select).toBeDisabled();
      await expect(select).toHaveValue("high");
      release();
      await expect(select).not.toBeVisible();
    });
    test(`${surface}: pending submission freezes reasoning and failure restores it`, async ({
      page,
    }) => {
      const select = await open(page, surface);
      await select.selectOption("high");
      const endpoint =
        surface === "Respawn"
          ? "/api/sessions/reasoning-source/respawn"
          : surface === "Handoff"
            ? "/api/sessions/reasoning-source/handoff"
            : "/api/spawn";
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**${endpoint}`, async (route) => {
        await held;
        await route.fulfill({ status: 400, json: { error: "Test request failed" } });
      });
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === endpoint && request.method() === "POST",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", {
          name:
            surface === "Respawn"
              ? /^respawn$/i
              : surface === "Handoff"
                ? /^handoff$/i
                : /^spawn$/i,
        })
        .click();
      expect((await requested).postDataJSON().reasoningEffort).toBe("high");
      await expect(select).toBeDisabled();
      await expect(select).toHaveValue("high");
      release();
      await expect(select).toBeEnabled();
      await expect(select).toHaveValue("high");
    });
  }
  for (const surface of surfaces) {
    for (const agent of agents) {
      test(`${surface} ${agent}: advertised levels and explicit request`, async ({ page }) => {
        const select = await open(page, surface, agent);
        await expect(select.locator("option")).toHaveText([
          /Reasoning · Default/,
          "Reasoning · Low",
          "Reasoning · Medium",
          "Reasoning · High",
        ]);
        await select.selectOption("medium");
        const payload = await submit(page, surface);
        expect(payload).toMatchObject({
          model: modelId(agent),
          reasoningEffort: "medium",
        });
        if (surface === "Respawn") expect(payload).not.toHaveProperty("agent");
        else expect(payload).toHaveProperty("agent", agent);
      });
    }
    test(`${surface}: ${surface === "Handoff" ? "source-agent Default clears override" : "live project Default stays omitted"}`, async ({
      page,
    }) => {
      const select = await open(page, surface);
      await expect(select).toHaveValue("default");
      await expect(select.locator("option").first()).toHaveText(/project: high/i);
      const body = await submit(page, surface);
      if (surface === "Handoff") expect(body.reasoningEffort).toBeNull();
      else expect(body).not.toHaveProperty("reasoningEffort");
    });
  }

  for (const surface of ["Respawn", "Handoff"] as const) {
    test(`${surface}: ${surface === "Handoff" ? "source agent selection clears former override" : "untouched current is omitted"}`, async ({
      page,
    }) => {
      const select = await open(page, surface, "claude", "medium");
      if (surface === "Handoff") {
        await expect(select).toHaveValue("default");
        await expect(select.locator("option").filter({ hasText: /current/ })).toHaveCount(0);
        expect(await submit(page, surface)).toHaveProperty("reasoningEffort", null);
      } else {
        await expect(select).toHaveValue("medium");
        await expect(select.locator("option:checked")).toHaveText("Reasoning · Medium · current");
        expect(await submit(page, surface)).not.toHaveProperty("reasoningEffort");
      }
    });
    test(`${surface}: Default deliberately clears current`, async ({ page }) => {
      const select = await open(page, surface, "claude", "medium");
      await select.selectOption("default");
      expect(await submit(page, surface)).toHaveProperty("reasoningEffort", null);
    });
    test(`${surface}: cross-agent drops carry`, async ({ page }) => {
      const select = await open(page, surface, "claude", "medium");
      await page.getByRole("combobox", { name: `${surface} agent` }).selectOption("codex");
      await expect(select).toHaveValue("default");
      await expect(select.locator("option").filter({ hasText: /current/ })).toHaveCount(0);
      expect(await submit(page, surface)).not.toHaveProperty("reasoningEffort");
    });
    test(`${surface}: ${surface === "Handoff" ? "source agent Default remains usable on capability error" : "unchanged current survives unavailable capabilities"}`, async ({
      page,
    }) => {
      const select = await open(page, surface, "claude", "medium", true);
      await expect(select).toBeDisabled();
      await expect(select.locator("option")).toHaveText("Reasoning · Unavailable");
      const body = await submit(page, surface);
      if (surface === "Handoff") expect(body.reasoningEffort).toBeNull();
      else expect(body).not.toHaveProperty("reasoningEffort");
    });
    test(`${surface}: ${surface === "Handoff" ? "cleared Default permits changed model on capability error" : "changed current model blocks unavailable capabilities"}`, async ({
      page,
    }) => {
      await open(page, surface, "claude", "medium", true);
      await page.getByRole("button", { name: `${surface} model` }).click();
      await page.getByRole("menuitem", { name: /Other model/ }).click();
      const submitButton = page
        .getByRole("dialog")
        .getByRole("button", { name: new RegExp(`^${surface}$`, "i") });
      if (surface === "Handoff") await expect(submitButton).toBeEnabled();
      else await expect(submitButton).toBeDisabled();
    });
  }

  test("project change refreshes Default without freezing effort", async ({ page }) => {
    const select = await open(page, "Spawn");
    await page.getByRole("combobox", { name: "Spawn project" }).selectOption("other-project");
    await expect(select.locator("option").first()).toHaveText(/project: low/i);
    expect(await submit(page, "Spawn")).not.toHaveProperty("reasoningEffort");
  });

  for (const surface of surfaces) {
    test(`${surface}: incompatible model resets surface intent`, async ({ page }) => {
      const select = await open(page, surface);
      await select.selectOption("high");
      await page.getByRole("button", { name: `${surface} model` }).click();
      await page.getByRole("menuitem", { name: /Unsupported model/ }).click();
      await expect(select).toBeDisabled();
      await expect(select.locator("option")).toHaveText("Reasoning · Not supported");
      await expect(
        page.getByText(/High not offered by Unsupported model, using Default/i),
      ).toBeVisible();
      const body = await submit(page, surface);
      if (surface === "Respawn" || surface === "Handoff")
        expect(body).toHaveProperty("reasoningEffort", null);
      else expect(body).not.toHaveProperty("reasoningEffort");
    });
  }

  test("capability failure disables reasoning without invented options", async ({ page }) => {
    await open(page, "Spawn");
    await page.route(/\/api\/models(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          agent: "codex",
          models: [{ id: modelId("codex"), label: "Reasoning model", isDefault: true }],
          defaultReasoningEfforts: [],
          reasoningError: "Capabilities unavailable",
        },
      }),
    );
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("codex");
    const select = page.getByRole("combobox", { name: "Spawn reasoning" });
    await expect(select).toBeDisabled();
    await expect(select.locator("option")).toHaveText("Reasoning · Unavailable");
    await expect(page.getByText("Capabilities unavailable").first()).toBeVisible();
  });

  test("OpenCode without a named model offers Pick a model", async ({ page }) => {
    await open(page, "Spawn");
    await page.route(/\/api\/models(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          agent: "opencode",
          models: [],
          defaultReasoningEfforts: [],
        },
      }),
    );
    await page.route(/\/api\/projects\/[^/]+\/spawn-defaults(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          model: null,
          worktree: true,
          reasoningEffort: null,
        },
      }),
    );
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("opencode");
    const select = page.getByRole("combobox", { name: "Spawn reasoning" });
    await expect(select).toBeDisabled();
    await expect(select.locator("option")).toHaveText("Reasoning · Pick a model");
    await expect(page.getByText("OpenCode needs a model for reasoning levels")).toBeVisible();
  });

  for (const surface of ["Respawn"] as const) {
    test(`${surface}: unsupported current resets clear`, async ({ page }) => {
      const select = await open(page, surface, "claude", "max");
      await expect(select).toHaveValue("default");
      await expect(
        page.getByText(/^Max not offered by (?:Reasoning model|this model), using Default$/i),
      ).toBeVisible();
      expect(await submit(page, surface)).toHaveProperty("reasoningEffort", null);
    });
  }

  test("Handoff: source-agent Default clears even an unsupported old override", async ({
    page,
  }) => {
    const select = await open(page, "Handoff", "claude", "max");
    await expect(select).toHaveValue("default");
    await expect(select.locator("option").filter({ hasText: /current/ })).toHaveCount(0);
    expect(await submit(page, "Handoff")).toHaveProperty("reasoningEffort", null);
  });

  test("loading and stale previous-agent response cannot overwrite options", async ({ page }) => {
    await open(page, "Spawn");
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/models(\?.*)?$/, async (route) => {
      const agent = new URL(route.request().url()).searchParams.get("agent");
      if (agent === "codex") await pending;
      await route.fulfill({
        json: {
          agent,
          defaultReasoningEfforts: [],
          models: [
            {
              id: modelId(agent as AgentName),
              label: "Reasoning model",
              isDefault: true,
              reasoningEfforts: agent === "codex" ? ["max"] : ["low"],
            },
          ],
        },
      });
    });
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("codex");
    await expect(page.getByLabel("Resolving reasoning")).toBeVisible();
    await page.getByRole("combobox", { name: "Spawn agent" }).selectOption("cursor");
    const select = page.getByRole("combobox", { name: "Spawn reasoning" });
    await expect(select.locator("option")).toHaveText([/Default/, "Reasoning · Low"]);
    release?.();
    await expect(select.locator("option[value=max]")).toHaveCount(0);
    await select.selectOption("low");
    expect(await submit(page, "Spawn")).toMatchObject({ agent: "cursor", reasoningEffort: "low" });
  });

  test("fresh draft preserves explicit choice across reload", async ({ page }) => {
    await page.route("**/api/preflight", (route) => route.fulfill({ json: { branch: null } }));
    const select = await open(page, "Spawn");
    await select.selectOption("medium");
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("spur:spawn-draft")))
      .toContain("medium");
    await page.reload();
    await page.getByRole("button", { name: /^spawn session$/i }).click();
    await expect(page.getByRole("combobox", { name: "Spawn reasoning" })).toHaveValue("medium");
    expect(await submit(page, "Spawn")).toHaveProperty("reasoningEffort", "medium");
  });

  for (const colorScheme of ["dark", "light"] as const) {
    test(`375px ${colorScheme}: square control, keyboard order, no overflow`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.addInitScript((theme) => localStorage.setItem("spur:theme", theme), colorScheme);
      const select = await open(page, "Spawn");
      const model = page.getByRole("button", { name: "Spawn model" });
      await model.focus();
      await page.keyboard.press("Tab");
      await expect(select).toBeFocused();
      const metrics = await select.evaluate((element) => ({
        radius: getComputedStyle(element).borderRadius,
        width: element.getBoundingClientRect().width,
        top: element.getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      expect(metrics.radius).toBe("0px");
      expect(metrics.overflow).toBe(false);
      expect(metrics.width).toBeGreaterThan(250);
      const modelBounds = await model.boundingBox();
      expect(modelBounds).not.toBeNull();
      if (modelBounds) expect(metrics.top).toBeGreaterThan(modelBounds.y);
    });
  }
});
