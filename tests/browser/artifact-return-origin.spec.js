import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const artifact = {
  id: "example",
  title: "Report",
  sessionId: "origin",
  projectId: "project-one",
  sizeBytes: 42,
  mediaType: "text/html",
  updatedAt: "2026-09-28T12:00:00.000Z",
};
const bundle = {
  artifact,
  entrypoint: "index.html",
  files: [
    ["index.html", '<h1>Report content</h1><a href="next.html">Next page</a>'],
    ["next.html", "<h1>Second page</h1>"],
  ].map(([path, html]) => ({
    path,
    mediaType: "text/html",
    base64: Buffer.from(html).toString("base64"),
  })),
};

async function fixture(context, { terminal = "", respond } = {}) {
  await context.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  // WebKit can lose the injected login cookie when its network process restarts
  // during the viewer reload; the login state is not what these tests cover.
  await context.route("**/auth/status", (route) =>
    route.fulfill({ json: { configured: true, authenticated: true, canSetup: false } }),
  );
  await context.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/artifacts/example/bundle")
      return respond ? respond(route) : route.fulfill({ json: bundle });
    let json = {};
    if (pathname === "/api/state")
      json = {
        tools: [{ id: "codex", name: "Codex", installed: true }],
        accounts: [],
        home: "/fixture",
        sessions: ["origin", "second"].map((id) => ({
          id,
          name: `Session ${id}`,
          tool: "codex",
          cwd: "/fixture/project",
          status: "stopped",
        })),
      };
    else if (pathname.endsWith("/chat"))
      json = {
        availability: "ready",
        tasks: [],
        messages: [
          {
            id: "answer",
            role: "assistant",
            text: `[Absolute report](${baseURL}/artifacts/view/example)\n\n[Relative report](/artifacts/view/example)`,
          },
        ],
      };
    else if (pathname.endsWith("/screen")) json = { text: terminal };
    else if (pathname === "/api/artifacts")
      json = { items: [artifact], total: 1, page: 1 };
    else if (pathname === "/api/artifacts/usage")
      json = { usedBytes: 42, pendingCleanupBytes: 0, limitBytes: 1024 };
    else if (pathname === "/api/memory/projects")
      json = { projects: [{ id: "project-one", name: "Example project" }] };
    return route.fulfill({ json });
  });
}

async function openViewer(page, click) {
  const opened = page.waitForEvent("popup");
  await click();
  const viewer = await opened;
  await expect(viewer.getByRole("link", { name: "Back to AgentPier" })).toBeVisible();
  expect(await viewer.evaluate(() => window.opener === null)).toBe(true);
  return viewer;
}

async function returnToSession(viewer, id, mode) {
  await expect(viewer.getByRole("link", { name: "Back to AgentPier" })).toHaveAttribute(
    "href",
    `/sessions/${id}/${mode}`,
  );
  const target = `${baseURL}/sessions/${id}/${mode}`;
  // WebKit occasionally drops a full-page load when its network process restarts;
  // retry the navigation while the viewer is still showing.
  await expect(async () => {
    if (viewer.url() !== target)
      await viewer
        .getByRole("link", { name: "Back to AgentPier" })
        .click({ timeout: 2000 });
    await expect(viewer).toHaveURL(target, { timeout: 3000 });
  }).toPass({ timeout: 15000 });
  await expect(viewer.getByRole("heading", { name: `Session ${id}` })).toBeVisible();
  await expect(viewer.locator(".segmented button.selected")).toHaveText(
    mode === "chat" ? "Chat" : "Terminal",
  );
}

async function terminalLink(page, text) {
  await expect(page.locator(".xterm-rows")).toContainText(text);
  const row = page.locator(".xterm-rows > div").filter({ hasText: text }).first();
  const screen = page.locator(".xterm-screen");
  const rowBox = await row.boundingBox();
  const screenBox = await screen.boundingBox();
  // xterm rows are painted beneath the screen that receives pointer events.
  const position = { x: 20, y: rowBox.y - screenBox.y + rowBox.height / 2 };
  await screen.hover({ position });
  await expect(page.locator(".xterm-cursor-pointer")).toBeVisible();
  return () => screen.click({ position });
}

for (const mode of ["chat", "terminal"])
  test(`session artifact dropdown returns to the originating ${mode}`, async ({
    page,
    context,
  }) => {
    await fixture(context);
    if (mode === "terminal") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/sessions/origin/${mode}`);
    await page.locator(".session-artifacts summary").click();
    const viewer = await openViewer(page, () =>
      page.getByRole("link", { name: "Open Report" }).click(),
    );
    await returnToSession(viewer, "origin", mode);
    if (process.env.CAPTURE_ARTIFACT_SCREENSHOTS && mode === "chat")
      await viewer.screenshot({ path: "docs/screenshots/artifact-return-chat.png" });
  });

for (const label of ["Absolute report", "Relative report"])
  test(`chat Markdown ${label} preserves its session after viewer reload`, async ({
    page,
    context,
  }) => {
    await fixture(context);
    await page.goto(`${baseURL}/sessions/origin/chat`);
    const viewer = await openViewer(page, () =>
      page.getByRole("link", { name: label }).click(),
    );
    await viewer.reload();
    await viewer.frameLocator("iframe").getByRole("link", { name: "Next page" }).click();
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Second page" }),
    ).toBeVisible();
    await returnToSession(viewer, "origin", "chat");
  });

for (const osc of [false, true])
  test(`terminal ${osc ? "OSC 8" : "plain URL"} artifact link returns to terminal`, async ({
    page,
    context,
  }) => {
    const url = `${baseURL}/artifacts/view/example`;
    const terminal = osc ? `\x1b]8;;${url}\x1b\\Open report\x1b]8;;\x1b\\\n` : `${url}\n`;
    await fixture(context, { terminal });
    await page.goto(`${baseURL}/sessions/origin/terminal`);
    const text = osc ? "Open report" : url;
    const viewer = await openViewer(page, await terminalLink(page, text));
    await returnToSession(viewer, "origin", "terminal");
  });

test("external OSC 8 destinations remain visible for confirmation before opening", async ({
  page,
  context,
}) => {
  const url = "https://outside.example/report";
  await fixture(context, { terminal: `\x1b]8;;${url}\x1b\\Open report\x1b]8;;\x1b\\\n` });
  await context.route(url, (route) => route.fulfill({ body: "External report" }));
  await page.goto(`${baseURL}/sessions/origin/terminal`);
  const click = await terminalLink(page, "Open report");
  const dialogs = [];
  page.once("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss();
  });
  await click();
  expect(dialogs).toEqual([{ type: "confirm", message: expect.stringContaining(url) }]);
  expect(context.pages()).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  const opened = page.waitForEvent("popup");
  await click();
  const popup = await opened;
  await expect(popup).toHaveURL(url);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
});

test("project artifact list preserves its project filter", async ({ page, context }) => {
  await fixture(context);
  await page.goto(`${baseURL}/artifacts/project-one`);
  const viewer = await openViewer(page, () =>
    page.getByRole("link", { name: "Open Report" }).click(),
  );
  await viewer.getByRole("link", { name: "Back to AgentPier" }).click();
  await expect(viewer).toHaveURL(`${baseURL}/artifacts/project-one`);
  await expect(
    viewer.getByRole("heading", { name: "Artifacts", exact: true }),
  ).toBeVisible();
});

test("independent viewer tabs retain independent session origins", async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.goto(`${baseURL}/sessions/origin/chat`);
  const first = await openViewer(page, () =>
    page.getByRole("link", { name: "Absolute report" }).click(),
  );
  await page.goto(`${baseURL}/sessions/second/terminal`);
  await page.locator(".session-artifacts summary").click();
  const second = await openViewer(page, () =>
    page.getByRole("link", { name: "Open Report" }).click(),
  );
  await first.reload();
  await returnToSession(first, "origin", "chat");
  await returnToSession(second, "second", "terminal");
});

for (const failure of ["loading", "unavailable", "unsupported"])
  test(`return context remains usable when the bundle is ${failure}`, async ({
    page,
    context,
  }) => {
    const pending = Promise.withResolvers();
    await fixture(context, {
      respond: async (route) => {
        if (failure === "loading") {
          await pending.promise;
          return route.abort().catch(() => {});
        }
        return route.fulfill(
          failure === "unavailable"
            ? { status: 404, json: { error: "Not found" } }
            : { json: { ...bundle, files: [] } },
        );
      },
    });
    try {
      await page.goto(`${baseURL}/sessions/origin/chat`);
      const viewer = await openViewer(page, () =>
        page.getByRole("link", { name: "Absolute report" }).click(),
      );
      await expect(
        viewer.getByRole(failure === "loading" ? "status" : "alert"),
      ).toBeVisible();
      await returnToSession(viewer, "origin", "chat");
    } finally {
      pending.resolve();
    }
  });
