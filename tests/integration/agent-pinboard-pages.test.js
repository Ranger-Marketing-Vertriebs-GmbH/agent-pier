import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gallery,
  pageFixture as fixture,
  sibling,
} from "../helpers/agent-pinboard-page-fixture.js";
import { png } from "../helpers/craft-pictures.js";
import { signedInUser } from "../helpers/users.js";
import { PAGE_CSP } from "../../server/features/assistants/agent-pinboard-pages.js";

const timeout = 30000;

test("a pinned HTML page reads as a page", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const [shown] = await f.view();
  assert.equal(shown.kind, "page");
  assert.equal(shown.type, "text/html");
  // The file route still only downloads it.
  const download = await f.request(
    `/api/assistants/${f.agent.id}/pinboard/entries/${entry.id}/file`,
  );
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition"), /^attachment/);
});

test("a page pinned as a download before turns into a page", { timeout }, async (t) => {
  const f = await fixture(t);
  f.pin("site/index.html");
  const [before] = await f.view();
  assert.equal(before.kind, "page");
  // As an older release stored it: same file, kind "file".
  const entry = f.store.entry(f.agent.id, before.id);
  f.store.setIdentity(
    entry.id,
    { ...entry.identity, type: "application/octet-stream", kind: "file" },
    { bump: false, expected: JSON.stringify(entry.identity) },
  );
  f.store.markSeen(f.agent.id, entry.id, entry.identity);
  const [after] = await f.view();
  assert.equal(after.kind, "page");
  assert.equal(after.version, before.version);
  assert.equal(after.fresh, false);
});

test("the page and its files come with the page policy", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const url = await f.grant(entry);
  assert.match(url, /^\/api\/pinboard-pages\/[A-Za-z0-9_-]{43}\/index\.html$/);
  const page = await f.frame(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), PAGE_CSP);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-frame-options"), null);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.equal(await page.text(), gallery);
  const expected = {
    "bilder/01.png": "image/png",
    "style/site.css": "text/css; charset=utf-8",
    "szenen.html": "text/html; charset=utf-8",
  };
  for (const [relative, type] of Object.entries(expected)) {
    const response = await f.frame(sibling(url, relative));
    assert.equal(response.status, 200, relative);
    assert.equal(response.headers.get("content-type"), type, relative);
    assert.equal(response.headers.get("content-security-policy"), PAGE_CSP, relative);
  }
  // A font arrives in CORS mode from the frame's opaque origin.
  f.file("site/fonts/a.woff2", "wOF2 font bytes");
  const font = await f.frame(sibling(url, "fonts/a.woff2"), { origin: "null" });
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("access-control-allow-origin"), "null");
  // The frame's grant opens nothing else of the API.
  const other = await f.frame(`/api/assistants/${f.agent.id}/pinboard`);
  assert.equal(other.status, 403);
});

test("only files below the page's folder of allowed types", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const url = await f.grant(entry);
  f.file("secret.png", png(2, 2));
  f.file("site/.hidden/a.png", png(2, 2));
  f.file("site/.env", "TOKEN=1");
  f.file("site/notes.txt", "notes");
  f.file("site/app.js", "alert(1)");
  f.file("site/bilder/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  f.file("site/bilder/fake.png", "<script>alert(1)</script>");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-page-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "x.png"), png(2, 2));
  fs.symlinkSync(path.join(outside, "x.png"), path.join(f.workspace, "site/linked.png"));
  fs.symlinkSync(outside, path.join(f.workspace, "site/linked"));
  // The URL parser takes encoded dots for dots: these leave the grant and its
  // exemption, and the API refuses the frame's cross-site request.
  for (const relative of ["%2E%2E/secret.png", "bilder/%2e%2e/%2e%2e/secret.png"]) {
    const response = await f.frame(sibling(url, relative));
    assert.equal(response.status, 403, relative);
  }
  for (const relative of [
    "..%2Fsecret.png",
    "bilder%2F01.png",
    ".hidden/a.png",
    ".env",
    "notes.txt",
    "app.js",
    "bilder/logo.svg",
    "bilder/fake.png",
    "linked.png",
    "linked/x.png",
    "missing.png",
    "bilder/",
  ]) {
    const response = await f.frame(sibling(url, relative));
    assert.equal(response.status, 404, relative);
  }
  // Without a grant in front, the frame's request is refused as cross-site.
  const escaped = await f.frame(url.replace(/[^/]+\/[^/]+$/, "x"));
  assert.equal(escaped.status, 403);
});

test("grants name one entry, one session and lapse", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  f.file("notes.md", "# Notes\n");
  const notes = f.pin("notes.md");
  // Only a page has a grant.
  assert.equal((await f.open(notes)).status, 404);
  assert.equal(
    (await f.frame(`/api/pinboard-pages/${"a".repeat(43)}/index.html`)).status,
    404,
  );
  const url = await f.grant(entry);
  // An unpinned page takes its grant along.
  f.store.unpin(f.agent.id, f.store.entry(f.agent.id, entry.id).list.id, {
    entryId: entry.id,
  });
  assert.equal((await f.frame(url)).status, 404);
  const again = f.pin("site/index.html");
  const second = await f.grant(again);
  assert.equal((await f.frame(second)).status, 200);
  // Signing out ends it.
  f.application.identity.revoke(f.cookie.split("=")[1]);
  assert.equal((await f.frame(second)).status, 404);
});

test("a restricted user gets no grant", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const { cookie } = await signedInUser(f);
  const response = await f.open(entry, { cookie });
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes("pinboard-pages"));
});

test("a user's own agent hides its pages without her opt-in", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const url = await f.grant(entry);
  const body = {
    ...f.service.store.storedAssistant(f.agent.id),
    userAccess: {
      mode: "own",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  };
  f.service.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.agent.id);
  assert.equal((await f.open(entry)).status, 404);
  assert.equal((await f.frame(url)).status, 404);
  assert.equal((await f.frame(sibling(url, "bilder/01.png"))).status, 404);
});
