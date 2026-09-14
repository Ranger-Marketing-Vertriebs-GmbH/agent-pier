import { test, expect } from "@playwright/test";
import {
  explorerFixture,
  explorerContext,
  explorerEntry,
  explorerListing,
  selectEnglish,
} from "../helpers/file-explorer-browser.js";
import { baseURL } from "../helpers/browser.js";
const d1 = `d1:${"1".repeat(64)}`,
  e1 = `e1:${"1".repeat(64)}`;
const document = (path, text = "first\n") => ({
  path,
  resolvedPath: path,
  text,
  revision: d1,
  metadataRevision: e1,
  bom: false,
  lineEnding: "lf",
  readOnly: false,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function spa(page, url) {
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}
async function open(page, path) {
  await expect(
    page.getByRole("button", { name: "readme.txt", exact: true }),
  ).toBeVisible();
  await spa(page, `/files?path=%2Fhome%2Ftest&file=${encodeURIComponent(path)}`);
  await expect(
    page.getByRole("region", { name: "File properties", exact: true }),
  ).toContainText(path);
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
}

test("out-of-order opens preserve active tab, selection-only state and scroll", async ({
  page,
}) => {
  await explorerFixture(page);
  const late = deferred();
  await page.route("**/api/files/text**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path.endsWith("slow.txt")) await late.promise;
    await route.fulfill({
      json: document(path, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")),
    });
  });
  await selectEnglish(page);
  await page.goto(`${baseURL}/files?path=%2Fhome%2Ftest`);
  await open(page, "/home/test/slow.txt");
  await open(page, "/home/test/fast.txt");
  late.resolve();
  const fast = page.getByRole("textbox", {
    name: "Document content: /home/test/fast.txt",
  });
  await expect(fast).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await fast.click();
  await fast.press("ControlOrMeta+Home");
  await fast.press("ArrowRight");
  await fast.press("ArrowRight");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.locator(".cm-scroller").hover();
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((node) => node.scrollTop))
    .toBeGreaterThan(250);
  await page.getByRole("tab", { name: "/home/test/slow.txt", exact: true }).click();
  await page.getByRole("tab", { name: "/home/test/fast.txt", exact: true }).click();
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((node) => node.scrollTop))
    .toBeGreaterThan(250);
  await fast.press("X");
  await expect(fast).toContainText("liXne 0");
});

test("lost reply retries exactly once on explicit action and keeps edits made during its reply", async ({
  page,
}) => {
  await explorerFixture(page);
  const reply = deferred();
  const requests = [];
  await page.route("**/api/files/text**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).searchParams.get("path");
    if (req.method() === "GET") return route.fulfill({ json: document(path) });
    requests.push({ id: req.headers()["x-file-request"], body: req.postData() });
    if (requests.length === 1) return route.fulfill({ status: 200, body: "{" });
    await reply.promise;
    return route.fulfill({
      json: {
        path,
        revision: `d1:${"2".repeat(64)}`,
        metadataRevision: `e1:${"2".repeat(64)}`,
      },
    });
  });
  await selectEnglish(page);
  await page.goto(`${baseURL}/files?path=%2Fhome%2Ftest&file=%2Fhome%2Ftest%2Fa.txt`);
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const content = page.getByRole("textbox", {
    name: "Document content: /home/test/a.txt",
  });
  await content.fill("attempt");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("FILE_INVALID_RESPONSE");
  expect(requests.length).toBe(1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await content.fill("newer edits");
  reply.resolve();
  await expect(
    page.getByText("Saved the attempted version. Newer edits remain unsaved."),
  ).toBeVisible();
  expect(requests[0]).toEqual(requests[1]);
  await expect(content).toHaveText("newer edits");
  await expect(page.getByRole("tab")).toContainText("•");
});

test("project drafts survive session, mode and CWD transitions without rebinding their scope", async ({
  page,
}) => {
  const { state } = await explorerFixture(page);
  const writes = [];
  let contextGate = null;
  let contextReads = 0;
  const session = {
    id: "editor-session",
    name: "Editor project",
    tool: "shell",
    cwd: "/work/one",
    status: "running",
    accountId: "local-shell",
  };
  state.sessions.push(session);
  await page.route("**/api/sessions/editor-session/files/explorer/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") || "";
    if (url.pathname.endsWith("/context")) {
      contextReads++;
      if (contextGate) await contextGate.promise;
      return route.fulfill({
        json: {
          ...explorerContext,
          scopeId: `f1:${session.cwd}`,
          kind: "project",
          root: session.cwd,
        },
      });
    }
    if (url.pathname.endsWith("/jobs"))
      return route.fulfill({ json: { jobs: [], nextCursor: null } });
    if (url.pathname.endsWith("/preferences"))
      return route.fulfill({ json: { favorites: [], showHidden: false } });
    if (url.pathname.endsWith("/metadata"))
      return route.fulfill({
        json:
          url.searchParams.get("view") === "document"
            ? {
                path,
                resolvedPath: path,
                metadataRevision: e1,
              }
            : explorerEntry("a.txt", "file", "folder"),
      });
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({ json: { type: "text", text: "first" } });
    if (url.pathname.endsWith("/text")) {
      if (route.request().method() === "PUT") {
        writes.push({
          path,
          scopeId: route.request().headers()["x-file-scope"],
          precondition:
            route.request().headers()["if-match"] ||
            route.request().headers()["if-none-match"],
          bytes: route.request().postDataBuffer(),
        });
        return route.fulfill({
          json: {
            path,
            revision: `d1:${"2".repeat(64)}`,
            metadataRevision: `e1:${"2".repeat(64)}`,
          },
        });
      }
      return route.fulfill({ json: document(path) });
    }
    return route.fulfill({ json: explorerListing(path) });
  });
  await selectEnglish(page);
  await page.goto(
    `${baseURL}/sessions/editor-session/files?path=folder&file=folder%2Fa.txt`,
  );
  await page.getByRole("button", { name: "Open in editor", exact: true }).click();
  const content = page.getByRole("textbox", { name: "Document content: folder/a.txt" });
  await content.fill("project draft");
  await spa(page, "/sessions/editor-session/terminal");
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await spa(page, "/sessions/editor-session/files");
  await expect(content).toContainText("project draft");
  await spa(page, "/files?path=%2Fhome%2Ftest");
  await expect(page).toHaveURL(/\/files\?path=/);
  await expect(content).toContainText("project draft");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await spa(page, "/sessions/editor-session/files");
  await content.fill("stale scope draft");
  session.cwd = "/work/two";
  await expect(
    page.getByText(
      "Draft retained from another workspace. Return to that workspace to save.",
    ),
  ).toBeVisible({ timeout: 7000 });
  await expect(content).toContainText("stale scope draft");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Save As path").fill("rescued.txt");
  await page.getByRole("button", { name: "Save new copy", exact: true }).click();
  await expect(page.getByText(/Independent copy saved.*rescued\.txt/)).toBeVisible();
  expect(writes.at(-1)).toMatchObject({
    path: "rescued.txt",
    scopeId: "f1:/work/two",
    precondition: "*",
  });
  expect(writes.at(-1).bytes.toString()).toBe("stale scope draft");
  expect(
    writes.some(
      (write) => write.path === "folder/a.txt" && write.scopeId === "f1:/work/two",
    ),
  ).toBe(false);

  const readsBeforeReturn = contextReads;
  session.cwd = "/work/one";
  await expect.poll(() => contextReads).toBeGreaterThan(readsBeforeReturn);
  await expect(
    page.getByText(
      "Draft retained from another workspace. Return to that workspace to save.",
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  const writesBeforePendingContext = writes.length;
  contextGate = deferred();
  const pendingGate = contextGate;
  const readsBeforePendingContext = contextReads;
  try {
    session.cwd = "/work/three";
    await expect.poll(() => contextReads).toBeGreaterThan(readsBeforePendingContext);
    await expect(
      page.getByText(
        "Draft retained from another workspace. Return to that workspace to save.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await content.press("ControlOrMeta+s");
    await page.waitForTimeout(200);
    expect(writes).toHaveLength(writesBeforePendingContext);
  } finally {
    pendingGate.resolve();
    contextGate = null;
  }
});

test("editor runtime stays unloaded and a late language cannot replace the active plain document", async ({
  page,
}) => {
  await explorerFixture(page);
  const assets = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/")) assets.push(request.url());
  });
  await page.route("**/api/files/text**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({
      json: document(
        path,
        path.endsWith(".js") ? "const answer = 42;" : "plain document",
      ),
    });
  });
  const held = [];
  let sharedEditorRuntimeLoaded = false;
  await page.route("**/assets/dist-*.js", async (route) => {
    // The merge UI creates one shared CodeMirror runtime chunk. Let that load so
    // the editor mounts, then hold the independently requested language chunk.
    if (!sharedEditorRuntimeLoaded) {
      sharedEditorRuntimeLoaded = true;
      return route.continue();
    }
    held.push(route);
  });
  await selectEnglish(page);
  expect(assets.some((url) => /FileEditor-/.test(url))).toBe(false);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Path", exact: true })).toBeVisible();
  expect(assets.some((url) => /FileEditor-/.test(url))).toBe(false);
  await open(page, "/home/test/code.js");
  await expect(
    page.getByRole("textbox", { name: "Document content: /home/test/code.js" }),
  ).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await open(page, "/home/test/plain.unknown");
  await expect(
    page.getByRole("textbox", { name: "Document content: /home/test/plain.unknown" }),
  ).toContainText("plain document");
  await page.unroute("**/assets/dist-*.js");
  await Promise.all(held.map((route) => route.continue()));
  await expect(
    page.getByRole("tab", { name: "/home/test/plain.unknown", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content .cm-line span")).toHaveCount(0);
  await expect(page.locator(".cm-editor")).toHaveCount(1);
});
