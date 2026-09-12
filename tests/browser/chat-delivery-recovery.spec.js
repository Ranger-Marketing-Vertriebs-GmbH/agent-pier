import { test, expect } from "@playwright/test";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

async function fixture(
  page,
  {
    outcome = "submitted-existing",
    disconnect = false,
    shared = null,
    sendInitial = true,
  } = {},
) {
  const state = shared || {
    inputs: [],
    recoveries: [],
    release: null,
    releases: [],
    status: "uncertain",
    attemptId: null,
  };
  await mockChatStream(page, () => ({ availability: "ready", messages: [], tasks: [] }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "claude", name: "Claude Code", installed: true }],
          accounts: [],
          sessions: [
            {
              id: "recovery",
              accountId: "local-claude",
              tool: "claude",
              createdAt: "2026-09-11",
              name: "Recovery",
              cwd: "/fixture",
              status: "running",
            },
          ],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    if (url.pathname.endsWith("/recovery")) {
      const body = route.request().postDataJSON();
      state.recoveries.push(body);
      if (disconnect) return route.abort();
      await new Promise((resolve) => {
        state.releases.push(resolve);
        state.release = () => state.releases.splice(0).forEach((finish) => finish());
      });
      const status = outcome === "blocked" ? "uncertain" : "handed-off";
      state.status = status;
      state.attemptId = outcome === "blocked" ? body.expectedAttemptId : body.attemptId;
      return route.fulfill({
        json: {
          deliveryId: state.inputs[0].deliveryId,
          attemptId: state.attemptId,
          status,
          recovery: {
            requestId: body.attemptId,
            action: outcome,
            reason:
              outcome === "blocked" ? "Der native Composer enthält anderen Text." : "",
          },
        },
      });
    }
    if (url.pathname.endsWith("/input")) {
      const body = route.request().postDataJSON();
      state.inputs.push(body);
      state.attemptId = body.deliveryId;
      return route.fulfill({
        json: {
          deliveryId: body.deliveryId,
          attemptId: body.deliveryId,
          status: state.status,
        },
      });
    }
    if (url.pathname.includes("/input/"))
      return route.fulfill({
        json: {
          deliveryId: url.pathname.split("/").at(-1),
          attemptId: state.attemptId,
          status: state.status,
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseURL + "/sessions/recovery/chat");
  if (!sendInitial) return state;
  await page.getByLabel("Nachricht", { exact: true }).fill("Original behalten");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "Zustellung unklar",
  );
  return state;
}

test("explicit recovery checks once and updates the original bubble", async ({
  page,
}) => {
  const state = await fixture(page);
  const retry = page.getByRole("button", { name: "Neu zustellen", exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "Wird geprüft",
  );
  await expect.poll(() => state.recoveries.length).toBe(1);
  expect(state.recoveries[0]).toMatchObject({
    text: "Original behalten",
    expectedAttemptId: state.inputs[0].deliveryId,
    mode: "retry",
  });
  state.release();
  await expect(retry).toHaveCount(0);
  await expect(page.locator(".chat-delivery-message")).toHaveCount(1);
  await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("");
  expect(state.inputs).toHaveLength(1);
});

test("lost recovery response survives reload and reuses its request ID only on explicit click", async ({
  page,
}) => {
  const state = await fixture(page, { disconnect: true });
  await page.getByRole("button", { name: "Neu zustellen", exact: true }).click();
  await expect.poll(() => state.recoveries.length).toBe(1);
  await page.reload();
  const retry = page.getByRole("button", { name: "Neu zustellen", exact: true });
  await expect(retry).toBeEnabled();
  expect(state.recoveries).toHaveLength(1);
  await retry.click();
  await expect.poll(() => state.recoveries.length).toBe(2);
  expect(state.recoveries[1]).toEqual(state.recoveries[0]);
  expect(state.inputs).toHaveLength(1);
});

test("blocked recovery explains the conflict, preserves the message and opens the TUI", async ({
  page,
}) => {
  const state = await fixture(page, { outcome: "blocked" });
  await page.getByRole("button", { name: "Neu zustellen", exact: true }).click();
  await expect.poll(() => Boolean(state.release)).toBe(true);
  state.release();
  await expect(page.getByText("Der native Composer enthält anderen Text.")).toBeVisible();
  await expect(page.locator(".chat-delivery-message")).toContainText("Original behalten");
  await page.getByRole("button", { name: "TUI öffnen", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/recovery\/terminal$/);
});

test("two tabs use the same durable recovery attempt", async ({ page, context }) => {
  const state = await fixture(page);
  const other = await context.newPage();
  await fixture(other, { shared: state, sendInitial: false });
  await Promise.all([
    page.getByRole("button", { name: "Neu zustellen", exact: true }).click(),
    other.getByRole("button", { name: "Neu zustellen", exact: true }).click(),
  ]);
  await expect.poll(() => state.recoveries.length).toBe(2);
  expect(state.recoveries[1]).toEqual(state.recoveries[0]);
  state.release();
  for (const tab of [page, other]) {
    await expect(
      tab.getByRole("button", { name: "Neu zustellen", exact: true }),
    ).toHaveCount(0);
    await expect(tab.locator(".chat-delivery-message")).toHaveCount(1);
  }
  expect(state.inputs).toHaveLength(1);
});

test("reload during recovery reads its result without resubmitting", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Neu zustellen", exact: true }).click();
  await expect.poll(() => Boolean(state.release)).toBe(true);
  await page.reload();
  expect(state.recoveries).toHaveLength(1);
  state.release();
  await expect(page.getByRole("status", { name: "Nachrichtenzustellung" })).toContainText(
    "An Sitzung übergeben",
  );
  expect(state.recoveries).toHaveLength(1);
  expect(state.inputs).toHaveLength(1);
});

test("failed bubble stays recoverable when another message is sent and after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.getByRole("button", { name: "Nach Prüfung als Entwurf übernehmen" }).click();
  await page.getByLabel("Nachricht", { exact: true }).fill("Andere Nachricht");
  // Keep the original receipt unresolved independently of the newer message.
  await page.route(
    "**/api/sessions/recovery/input/" + state.inputs[0].deliveryId + "?*",
    (route) =>
      route.fulfill({
        json: {
          deliveryId: state.inputs[0].deliveryId,
          attemptId: state.inputs[0].deliveryId,
          status: "uncertain",
        },
      }),
  );
  state.status = "handed-off";
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(page.getByLabel("Nachricht", { exact: true })).toHaveValue("");
  await page.reload();
  const original = page
    .locator(".chat-delivery-message")
    .filter({ hasText: "Original behalten" });
  await expect(original).toContainText("Zustellung unklar");
  await expect(
    original.getByRole("button", { name: "Neu zustellen", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-delivery-message")).toHaveCount(2);
  await page.screenshot({ path: ".cache/chat-recovery-mobile.png" });
});

test("a handed-off message offers inspection with no retry permission", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Neu zustellen", exact: true }).click();
  await expect.poll(() => Boolean(state.release)).toBe(true);
  state.release();
  const inspect = page.getByRole("button", { name: "Übergabe prüfen", exact: true });
  await expect(inspect).toBeEnabled();
  await inspect.click();
  await expect.poll(() => state.recoveries.length).toBe(2);
  expect(state.recoveries[1].mode).toBe("check");
  expect(state.recoveries[1].expectedAttemptId).toBe(state.recoveries[0].attemptId);
  state.release();
  await expect(inspect).toBeEnabled();
  expect(state.inputs).toHaveLength(1);
});
