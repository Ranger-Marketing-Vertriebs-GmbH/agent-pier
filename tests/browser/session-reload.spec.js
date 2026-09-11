import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page, language = "en") {
  const state = {
    session: {
      id: "reload",
      accountId: "local-codex",
      tool: "codex",
      createdAt: "2026-09-09",
      name: "Reload fixture",
      cwd: "/fixture",
      status: "running",
      restartGeneration: 0,
    },
    reload: {
      eligible: true,
      reason: null,
      nativeId: "native-fixture",
      activity: { state: "busy" },
      state: "idle",
    },
    posts: [],
    deletes: 0,
    inputs: [],
    gets: 0,
    sockets: 0,
    terminalInputs: [],
    holdPost: null,
    abortPost: false,
    rejectPost: false,
    assignedIds: [],
    tools: { state: "reload-required" },
  };
  await page.addInitScript(
    (language) => localStorage.setItem("agentpier-language", language),
    language,
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [],
          sessions: [state.session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/reload")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        state.posts.push(body);
        if (state.abortPost) return route.abort();
        if (state.rejectPost)
          return route.fulfill({
            status: 409,
            json: { error: "Activity changed; acknowledge interruption" },
          });
        state.reload = {
          ...state.reload,
          state:
            body.mode === "when-idle"
              ? "waiting"
              : state.awaitingHooks
                ? "reloading"
                : "completed",
          requestId: body.requestId,
        };
        state.session.reload = { ...state.reload };
        if (body.mode === "now") state.session.restartGeneration++;
        if (state.failSwitch) {
          state.session.deliveryAccountId ||= state.session.accountId;
          state.session.accountId = body.targetAccountId || state.session.accountId;
          state.reload = {
            ...state.reload,
            state: "failed",
            accountId: state.session.accountId,
            targetAccountId: body.targetAccountId || null,
            accountTargets: [{ id: "local-codex", name: "Original account" }],
          };
          state.session.reload = { ...state.reload };
        }
        if (state.holdPost) {
          state.reload.state = "reloading";
          state.session.reload = { ...state.reload };
          await state.holdPost;
        }
      } else if (request.method() === "DELETE") {
        state.deletes++;
        state.reload = { ...state.reload, state: "idle" };
        state.session.reload = { ...state.reload };
      } else state.gets++;
      return route.fulfill({ json: state.reload });
    }
    if (path.endsWith("/ssh-accesses")) {
      if (request.method() === "PUT")
        state.assignedIds = request.postDataJSON().accessIds;
      return route.fulfill({
        json: {
          tools: state.tools,
          assignedIds: state.assignedIds,
          accesses: [
            {
              id: "ssh-one",
              name: "Build server",
              host: "build.example.test",
              username: "deploy",
              port: 22,
            },
          ],
          commands: state.assignedIds.map((id) => ({
            id,
            command: "fixture-helper --access ssh-one",
          })),
        },
      });
    }
    if (path.endsWith("/chat"))
      return route.fulfill({
        json: {
          availability: "ready",
          messages: [{ id: "prior", role: "assistant", text: "Existing answer" }],
          tasks: [],
        },
      });
    if (path.endsWith("/input")) state.inputs.push(request.postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/terminal", (socket) => {
    state.sockets++;
    socket.send(JSON.stringify({ type: "status", status: "running" }));
    socket.onMessage((message) => {
      const value = JSON.parse(message);
      if (value.type === "input") state.terminalInputs.push(value.data);
    });
  });
  await page.goto(baseURL + "/sessions/reload/chat");
  return state;
}
const dialog = (page) => page.getByRole("dialog");
const open = (page) =>
  page.getByRole("button", { name: "Reload & resume", exact: true }).click();

test("pending reload lets users open the terminal and approve hooks", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  let finish;
  state.holdPost = new Promise((resolve) => {
    finish = resolve;
  });
  try {
    await open(page);
    await dialog(page).getByRole("button", { name: "Reload now", exact: true }).click();
    await expect(dialog(page)).toContainText("Sending reload request");
    await dialog(page)
      .getByRole("button", { name: "Open terminal", exact: true })
      .click();
    await expect(dialog(page)).not.toBeVisible();
    await expect.poll(() => state.sockets).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Send Enter", exact: true }).click();
    await expect.poll(() => state.terminalInputs).toContain("\r");
    expect(state.posts).toHaveLength(1);
    expect(state.inputs).toEqual([]);
  } finally {
    finish();
  }
});

test("busy reload requires acknowledgement and preserves chat draft and history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  const input = page.getByLabel("Message", { exact: true });
  await input.fill("Keep my draft");
  await open(page);
  const now = dialog(page).getByRole("button", { name: "Reload now", exact: true });
  await expect(now).toBeDisabled();
  await dialog(page).getByRole("checkbox").check();
  await page.screenshot({ path: "docs/screenshots/session-reload-mobile.png" });
  await now.click();
  await expect(dialog(page)).toContainText(
    "Conversation resumed with refreshed integrations.",
  );
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]).toMatchObject({ mode: "now", interrupt: true });
  await page.screenshot({ path: ".cache/session-reload-mobile-en.png" });
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(input).toHaveValue("Keep my draft");
  await expect(page.getByText("Existing answer", { exact: true })).toBeVisible();
  expect(state.inputs).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("queued reload remains visible after closing and can be cancelled", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "Wait until idle", exact: true })
    .click();
  await expect(dialog(page)).toContainText("Reload queued · waiting until idle");
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reload queued · waiting until idle", exact: true }),
  ).toBeVisible();
  await open(page);
  await dialog(page)
    .getByRole("button", { name: "Cancel queued reload", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("button", { name: "Wait until idle", exact: true }),
  ).toBeVisible();
  expect(state.deletes).toBe(1);
  expect(state.posts[0]).toMatchObject({ mode: "when-idle", interrupt: false });
});

test("ambiguous POST retries the same request after closing the dialog", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  state.abortPost = true;
  await open(page);
  await dialog(page).getByRole("button", { name: "Reload now", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not be confirmed");
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await open(page);
  state.abortPost = false;
  await dialog(page).getByRole("button", { name: "Retry request", exact: true }).click();
  await expect(dialog(page)).toContainText("Conversation resumed");
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toEqual(state.posts[0]);
});

test("SSH reload requires saved assignments and advanced commands stay collapsed", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Server accesses", exact: true }).click();
  await dialog(page)
    .getByRole("checkbox", { name: /Build server/ })
    .check();
  await expect(dialog(page)).toContainText("Save your host selection before reloading.");
  await expect(
    dialog(page).getByRole("button", { name: "Reload & resume", exact: true }),
  ).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    dialog(page).getByText("fixture-helper --access ssh-one", { exact: true }),
  ).not.toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "Reload & resume", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("heading", { name: "Reload & resume", exact: true }),
  ).toBeVisible();
  expect(state.assignedIds).toEqual(["ssh-one"]);
  expect(state.posts).toEqual([]);
});

test("SSH readiness updates without losing unsaved choices", async ({ page }) => {
  const state = await fixture(page, "de");
  await page.setViewportSize({ width: 390, height: 844 });
  state.tools.state = "starting";
  await page.getByRole("button", { name: "Serverzugänge", exact: true }).click();
  await expect(dialog(page)).toContainText("Warte auf die Verbindung der CLI");
  await dialog(page)
    .getByRole("checkbox", { name: /Build server/ })
    .check();
  state.tools.state = "ready";
  await expect(dialog(page)).toContainText(
    "SSH-Werkzeuge sind für diese Sitzung bereit.",
  );
  await expect(
    dialog(page).getByRole("checkbox", { name: /Build server/ }),
  ).toBeChecked();
  await page.screenshot({ path: "docs/screenshots/ssh-tools-mobile.png" });
  expect(state.assignedIds).toEqual([]);
});

test("unverified native conversation disables reload and German copy is available", async ({
  page,
}) => {
  const state = await fixture(page, "de");
  state.reload.eligible = false;
  state.reload.reason = "native-session-unverified";
  await page.getByRole("button", { name: "Neu laden & fortsetzen", exact: true }).click();
  await expect(dialog(page)).toContainText(
    "Die native Unterhaltung ist noch nicht verifiziert.",
  );
  await expect(
    dialog(page).getByRole("button", { name: "Jetzt neu laden", exact: true }),
  ).toHaveCount(0);
  expect(state.posts).toEqual([]);
});

test("confirmed validation rejection allows a corrected new request and stays visible during polling", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  state.rejectPost = true;
  await open(page);
  await dialog(page).getByRole("button", { name: "Reload now", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Activity changed");
  const gets = state.gets;
  await expect.poll(() => state.gets).toBeGreaterThan(gets);
  await expect(dialog(page).getByRole("alert")).toContainText("Activity changed");
  await expect(
    dialog(page).getByRole("button", { name: "Retry request", exact: true }),
  ).toHaveCount(0);
  state.rejectPost = false;
  await dialog(page)
    .getByRole("button", { name: "Wait until idle", exact: true })
    .click();
  await expect(dialog(page)).toContainText("Reload queued");
  expect(state.posts).toHaveLength(2);
  expect(state.posts[1].requestId).not.toBe(state.posts[0].requestId);
});

test("successful reload reconnects the terminal using its public restart generation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(() => state.sockets).toBe(1);
  await open(page);
  await dialog(page).getByRole("button", { name: "Reload now", exact: true }).click();
  await expect(dialog(page)).toContainText("Conversation resumed");
  await expect.poll(() => state.sockets).toBe(2);
  expect(state.session.restartGeneration).toBe(1);
  expect(state.inputs).toEqual([]);
});

for (const tool of ["codex", "claude"]) {
  test(`${tool} account switch sends selected target and retains the draft`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await fixture(page);
    state.session.tool = tool;
    state.reload.activity = { state: "idle" };
    state.reload.accountTargets = [{ id: "second-account", name: "Second account" }];
    await page.reload();
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Keep this draft across accounts");
    await page
      .getByRole("button", { name: "Continue with another account", exact: true })
      .click();
    const now = dialog(page).getByRole("button", {
      name: "Switch account & resume",
      exact: true,
    });
    await expect(now).toBeDisabled();
    await dialog(page)
      .getByLabel("Target account", { exact: true })
      .selectOption("second-account");
    await page.screenshot({ path: `.cache/session-account-switch-${tool}.png` });
    await now.click();
    expect(state.posts[0]).toMatchObject({
      mode: "now",
      targetAccountId: "second-account",
    });
    state.session.deliveryAccountId = state.session.accountId;
    state.session.accountId = "second-account";
    await page.reload();
    await expect(input).toHaveValue("Keep this draft across accounts");
    expect(state.inputs).toEqual([]);
  });
}

test("a failed account startup can retry the current target without switching again", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  state.reload.accountTargets = [{ id: "second-account", name: "Second account" }];
  state.failSwitch = true;
  await page
    .getByRole("button", { name: "Continue with another account", exact: true })
    .click();
  await dialog(page)
    .getByLabel("Target account", { exact: true })
    .selectOption("second-account");
  await dialog(page)
    .getByRole("button", { name: "Switch account & resume", exact: true })
    .click();
  const retry = dialog(page).getByRole("button", {
    name: "Retry with current account",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toBeEnabled();
  state.failSwitch = false;
  await retry.click();
  expect(state.posts).toHaveLength(3);
  expect(state.posts[1].targetAccountId).toBeUndefined();
  await expect(dialog(page)).toContainText(
    "Conversation resumed with refreshed integrations.",
  );
});

test("a started reload opens the terminal automatically for delayed hook approval", async ({
  page,
}) => {
  const state = await fixture(page);
  state.reload.activity = { state: "idle" };
  state.awaitingHooks = true;
  await open(page);
  await dialog(page).getByRole("button", { name: "Reload now", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await expect.poll(() => state.sockets).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Send Enter", exact: true }).click();
  await expect.poll(() => state.terminalInputs).toContain("\r");
  expect(state.posts).toHaveLength(1);
});
