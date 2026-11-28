import { test, expect, type Page, makeCompletedSession, mockTagCatalog } from "./fixtures.js";

const system = { kind: "system", source: "handoff" } as const;
const at = "2026-11-01T10:00:00.000Z";
const longReason =
  "Waiting for the product owner to confirm the public command name before any code lands";
const fullItemId = "12345678-1234-1234-1234-123456789012";

function todoItem(
  id: string,
  text: string,
  status: "open" | "cancelled" | "held",
  extra: Record<string, unknown>,
) {
  return {
    id,
    text,
    status,
    added: { reason: "Ship the retry fix before release", actor: system, at },
    history: [],
    ...extra,
  };
}

const items = [
  todoItem(fullItemId, "Inherited open item", "open", {
    handoffFrom: { sessionId: "api-1", itemId: "old-1" },
  }),
  todoItem("inherited-moved", "Inherited item with a transition", "open", {
    handoffFrom: { sessionId: "api-1", itemId: "old-2" },
    latestTransition: { type: "resumed", actor: system, at },
    added: { reason: longReason, actor: system, at },
  }),
  todoItem("handed-off-src", "Handed-off source item", "cancelled", {
    handoffTo: { sessionId: "api-3", itemId: "new-1" },
    latestTransition: { type: "cancelled", reason: "handed off to api-3", actor: system, at },
  }),
  todoItem("rolled-back-cp", "Rolled-back inherited copy", "cancelled", {
    handoffFrom: { sessionId: "api-1", itemId: "old-3" },
    latestTransition: {
      type: "cancelled",
      reason: "handoff to api-4 failed; item stays open in api-1",
      actor: system,
      at,
    },
  }),
];

async function mockTodoPage(page: Page, sessionId: string, held = false) {
  const session = makeCompletedSession({ id: sessionId });
  await mockTagCatalog(page);
  await page.route(`**/api/sessions/${sessionId}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route(`**/api/sessions/${sessionId}/todo`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revision: "event-1",
        status: "active",
        counts: { total: 4, open: held ? 1 : 2, held: held ? 1 : 0, completed: 0, cancelled: 2 },
        items: held
          ? [
              {
                ...items[0],
                status: "held",
                latestTransition: {
                  type: "held",
                  reason: longReason,
                  actor: system,
                  at,
                  blocker: { kind: "human", requiredAction: "Confirm the command name" },
                },
              },
              ...items.slice(1),
            ]
          : items,
        finishOverrides: [],
      }),
    });
  });
}

function row(page: Page, title: string) {
  return page.getByRole("button", { name: new RegExp(title) });
}

test.describe("Spur ToDo handoff provenance", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1133, 390]) {
      test(`wraps the full expanded item ID inside its row at ${width}px in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await mockTodoPage(page, "todo-full-id");
        await page.goto("/sessions/todo-full-id");
        await page.evaluate((value) => {
          document.documentElement.setAttribute("data-theme", value);
        }, theme);

        const item = row(page, "Inherited open item");
        await item.click();
        await expect(item).toHaveAttribute("aria-expanded", "true");
        const id = item.getByText(fullItemId, { exact: true });
        await expect(id).toBeVisible();
        const metrics = await id.evaluate((element) => {
          const button = element.closest("button");
          if (!button) throw new Error("Expected the ToDo row button");
          const range = document.createRange();
          range.selectNodeContents(element);
          const bounds = element.getBoundingClientRect();
          const rowBounds = button.getBoundingClientRect();
          return {
            text: element.textContent,
            whiteSpace: getComputedStyle(element).whiteSpace,
            clientWidth: button.clientWidth,
            scrollWidth: button.scrollWidth,
            left: Math.max(bounds.left, rowBounds.left),
            right: Math.min(bounds.right, rowBounds.right),
            textRects: [...range.getClientRects()].map((rect) => ({
              left: rect.left,
              right: rect.right,
            })),
          };
        });
        expect(metrics.text).toBe(fullItemId);
        expect(metrics.whiteSpace).not.toBe("nowrap");
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
        expect(metrics.textRects.length).toBeGreaterThan(0);
        for (const rect of metrics.textRects) {
          expect(rect.left).toBeGreaterThanOrEqual(metrics.left - 1);
          expect(rect.right).toBeLessThanOrEqual(metrics.right + 1);
        }
      });
    }
  }

  test("shows the source on inherited items and the right glyph on cancelled ones", async ({
    page,
  }) => {
    await mockTodoPage(page, "todo-handoff-desktop");
    await page.goto("/sessions/todo-handoff-desktop");
    await page.getByText("All tasks & history", { exact: true }).click();

    await expect(row(page, "Inherited open item")).toBeVisible();
    await expect(
      row(page, "Inherited open item").getByText("From api-1 · Ship the retry fix before release", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      row(page, "Inherited item with a transition").getByText(`From api-1 · ${longReason}`),
    ).toBeVisible();

    const handedOff = row(page, "Handed-off source item").getByRole("img", { name: "handed off" });
    await expect(handedOff).toHaveText("→");
    await expect(
      row(page, "Handed-off source item").getByText("handed off to api-3"),
    ).toBeVisible();

    const rolledBack = row(page, "Rolled-back inherited copy").getByRole("img", {
      name: "cancelled",
    });
    await expect(rolledBack).toHaveText("×");
    await expect(page.getByRole("img", { name: "handed off" })).toHaveCount(1);
  });

  test("keeps the inherited secondary line on one line at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockTodoPage(page, "todo-handoff-phone");
    await page.goto("/sessions/todo-handoff-phone");
    await page.getByText("All tasks & history", { exact: true }).click();

    const line = row(page, "Inherited item with a transition").getByText(/^From api-1 · /);
    await expect(line).toBeVisible();
    const metrics = await line.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        overflowsX: element.scrollWidth > element.clientWidth,
      };
    });
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 1.5);
    expect(metrics.overflowsX).toBe(true);
    const button = row(page, "Inherited item with a transition");
    const buttonOverflow = await button.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(buttonOverflow.scrollWidth).toBe(buttonOverflow.clientWidth);
  });

  test("keeps held reasons and required action exposed on phone while history is folded", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockTodoPage(page, "todo-held-phone", true);
    await page.goto("/sessions/todo-held-phone");
    await expect(page.getByText(longReason, { exact: true })).toBeVisible();
    await expect(
      page.getByText("From api-1 · Human action: Confirm the command name"),
    ).toBeVisible();
    await expect(page.getByText("All tasks & history").locator("..")).not.toHaveAttribute("open");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
