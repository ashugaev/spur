import { test, expect, makeStoppedSession, mockSessions, type SpurSessionView } from "./fixtures.js";

test("restores daemon-owned Working after reload and follows settlement before POST returns", async ({ page }) => {
  const source = makeStoppedSession({ id: "server-owned-restore", prompt: "Server-owned restore" });
  let rows = [source];
  let operationId = "";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await mockSessions(page, () => rows);
  await page.route(`**/api/sessions/${source.id}/restore`, async (route) => {
    operationId = (route.request().postDataJSON() as { operationId: string }).operationId;
    rows = [{ ...source, lifecycle: { instanceId: "test-instance", revision: 1, operation: {
      operationId, action: "restore", phase: "pending", targetIds: [source.id], outcomes: [],
    } } }];
    await held;
    await route.fulfill({ json: rows[0] });
  });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: `Restore session ${source.id}` }).click();
  await expect.poll(() => operationId).toMatch(/^[0-9a-f-]{36}$/);
  await page.clock.runFor(5_200);
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Restore session ${source.id}` })).toHaveCount(0);
  rows = [{ ...source, status: "running", state: "waiting", runtimeAlive: true,
    lifecycle: { instanceId: "test-instance", revision: 2, operation: {
      operationId, action: "restore", phase: "succeeded", targetIds: [source.id],
      outcomes: [{ sessionId: source.id, phase: "succeeded" }],
    } } }];
  await page.clock.runFor(5_200);
  await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
  release();
});

test("reconciles delivery 503 from current settled GET without replaying restore", async ({ page }) => {
  const source = makeStoppedSession({ id: "delivery-restore", prompt: "Delivery restore" });
  let rows: SpurSessionView[] = [source];
  let calls = 0;
  await mockSessions(page, () => rows);
  await page.route(`**/api/sessions/${source.id}/restore`, async (route) => {
    calls += 1;
    const { operationId } = route.request().postDataJSON() as { operationId: string };
    const lifecycle: NonNullable<SpurSessionView["lifecycle"]> = {
      instanceId: "test-instance", revision: 2, operation: {
        operationId, action: "restore", phase: "succeeded", targetIds: [source.id],
        outcomes: [{ sessionId: source.id, phase: "succeeded" }],
      },
    };
    rows = [{ ...source, status: "running", state: "waiting", runtimeAlive: true, lifecycle }];
    await route.fulfill({ status: 503, json: {
      code: "session_lifecycle_snapshot_changed", error: "Response delivery changed", lifecycle,
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: `Restore session ${source.id}` }).click();
  await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Restore session ${source.id}` })).toHaveCount(0);
  expect(calls).toBe(1);
});
