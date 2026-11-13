import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  pageFixture as fixture,
  sibling,
} from "../helpers/agent-pinboard-page-fixture.js";
import { png } from "../helpers/craft-pictures.js";
import { pageClient } from "../../server/http/routes/pinboard-pages.js";

const timeout = 30000;
const font = fs.readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2",
  ),
);

// A request exactly as written, never normalised the way fetch() normalises a URL;
// `onResponse(res, req)` may take over reading the body.
function raw(f, target, { method = "GET", onResponse } = {}) {
  const { hostname, port } = new URL(f.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path: target,
        method,
        headers: { host: `${hostname}:${port}`, "sec-fetch-site": "cross-site" },
      },
      (res) => {
        if (onResponse) return resolve(onResponse(res, req));
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("raw dot segments never leave the page's folder", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("secret.png", png(2, 2));
  const url = await f.grant(f.pin("site/index.html"));
  for (const relative of [
    "../secret.png",
    "bilder/../../secret.png",
    "%2e%2e/secret.png",
    "bilder/%2E%2E/%2e%2e/secret.png",
    "./bilder/01.png",
  ])
    assert.equal(await raw(f, sibling(url, relative)), 404, relative);
  assert.equal(await raw(f, sibling(url, "bilder/01.png")), 200);
});

test("a hard-linked file is refused", { timeout }, async (t) => {
  const f = await fixture(t);
  const url = await f.grant(f.pin("site/index.html"));
  const original = f.file("site/bilder/02.png", png(2, 2));
  fs.linkSync(original, path.join(f.workspace, "site/bilder/02-copy.png"));
  for (const name of ["02.png", "02-copy.png"])
    assert.equal((await f.frame(sibling(url, `bilder/${name}`))).status, 404, name);
});

test(
  "types are served as declared, fonts only by their bytes",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const url = await f.grant(f.pin("site/index.html"));
    f.file("site/evil.css", "<html><script>alert(1)</script></html>");
    const css = await f.frame(sibling(url, "evil.css"));
    assert.equal(css.status, 200);
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(css.headers.get("x-content-type-options"), "nosniff");
    assert.equal(css.headers.get("access-control-allow-origin"), null);
    f.file("site/fonts/dm.woff2", font);
    f.file("site/fonts/plain.ttf", Buffer.from([0, 1, 0, 0, 9, 9, 9, 9]));
    f.file("site/fonts/fake.woff2", "<html><script>alert(1)</script></html>");
    f.file("site/fonts/fake.otf", "OTT");
    for (const name of ["dm.woff2", "plain.ttf"]) {
      const response = await f.frame(sibling(url, `fonts/${name}`), { origin: "null" });
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("access-control-allow-origin"), "null", name);
    }
    for (const name of ["fake.woff2", "fake.otf"])
      assert.equal((await f.frame(sibling(url, `fonts/${name}`))).status, 404, name);
    // HEAD names the file without its bytes.
    const head = await f.request(sibling(url, "bilder/01.png"), {
      method: "HEAD",
      origin: null,
      headers: { cookie: "", "sec-fetch-site": "cross-site" },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "image/png");
    assert.equal(Number(head.headers.get("content-length")), png(4, 4).length);
    assert.equal(await head.text(), "");
  },
);

test(
  "a page in a granted project folder reads its files there",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const registered = await f.request("/api/memory/projects", {
      method: "POST",
      body: { cwd: f.project },
    });
    assert.equal(registered.status, 201);
    const project = await registered.json();
    const access = await f.request(
      `/api/assistant-project-access/${project.id}/${f.agent.id}`,
      {
        method: "PUT",
        body: {
          expected: { coding: false, folder: "none" },
          coding: true,
          folder: "read",
        },
      },
    );
    assert.equal(access.status, 200);
    fs.mkdirSync(path.join(f.project, "site/bilder"), { recursive: true });
    fs.writeFileSync(path.join(f.project, "site/index.html"), "<img src=bilder/a.png>");
    fs.writeFileSync(path.join(f.project, "site/bilder/a.png"), png(2, 2));
    const url = await f.grant(
      f.pin("site/index.html", { root: `project:${project.id}` }),
    );
    assert.equal((await f.frame(url)).status, 200);
    assert.equal((await f.frame(sibling(url, "bilder/a.png"))).status, 200);
    assert.equal((await f.frame(sibling(url, "bilder/b.png"))).status, 404);
  },
);

test("without its chat, no upload or inbound media is served", { timeout }, async (t) => {
  const f = await fixture(t);
  f.file("index.html", "<img src=attachments/a.png><img src=media/inbound/b.png>");
  f.file("attachments/a.png", png(2, 2));
  f.file("media/inbound/b.png", png(2, 2));
  f.file("media/inbound/page.html", "<p>inbound</p>");
  const url = await f.grant(f.pin("index.html"));
  assert.equal((await f.frame(url)).status, 200);
  for (const relative of ["attachments/a.png", "media/inbound/b.png"])
    assert.equal((await f.frame(sibling(url, relative))).status, 404, relative);
  // Nor is an inbound page itself.
  assert.equal((await f.open(f.pin("media/inbound/page.html"))).status, 404);
});

test("a grant answers only the client it was issued to", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  await f.view();
  const session = f.cookie.split("=")[1];
  const pages = f.service.pinboard.pages;
  for (const client of ["tailscale:mallory@example.com", "network:192.0.2.7"]) {
    const url = await pages.issue(f.agent.id, entry.id, { session, client });
    assert.equal((await f.frame(url)).status, 404, client);
  }
  const own = await pages.issue(f.agent.id, entry.id, {
    session,
    client: "local:127.0.0.1",
  });
  assert.equal((await f.frame(own)).status, 200);
  // Who asks: the Tailscale login on that branch, the address on the others.
  const req = (trustBranch, headers = {}) => ({
    trustBranch,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.equal(
    pageClient(req("tailscale", { "tailscale-user-login": "owner@example.com" })),
    "tailscale:owner@example.com",
  );
  assert.equal(pageClient(req("local")), "local:127.0.0.1");
  assert.equal(pageClient(req("network")), "network:127.0.0.1");
});

test("a deleted agent's grant reads nothing", { timeout }, async (t) => {
  const f = await fixture(t);
  const url = await f.grant(f.pin("site/index.html"));
  // As the purge removes a deleted agent's rows (agent-deletion.js).
  const db = f.service.store.db;
  for (const table of [
    "agent_pinboard_entries",
    "agent_pinboard_lists",
    "agent_pinboard_changes",
  ])
    db.prepare(`DELETE FROM ${table} WHERE assistant_id=?`).run(f.agent.id);
  db.prepare("DELETE FROM assistants WHERE id=?").run(f.agent.id);
  assert.equal((await f.frame(url)).status, 404);
});

test("unknown grants never spend the owner's read budget", { timeout }, async (t) => {
  const f = await fixture(t);
  const entry = f.pin("site/index.html");
  const garbage = `/api/pinboard-pages/${"x".repeat(43)}/index.html`;
  // More than the owner's 600 reads a minute.
  for (let round = 0; round < 13; round++) {
    const statuses = await Promise.all(
      Array.from({ length: 50 }, () => f.frame(garbage).then((r) => r.status)),
    );
    assert.ok(statuses.every((status) => status === 404));
  }
  const file = await f.request(
    `/api/assistants/${f.agent.id}/pinboard/entries/${entry.id}/file`,
  );
  assert.equal(file.status, 200);
  assert.equal((await f.frame(await f.grant(entry))).status, 200);
});

test("signing out ends a page file in flight", { timeout }, async (t) => {
  const f = await fixture(t);
  // An MP4 head and 40 MiB more: far beyond what the socket buffers hold.
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  ftyp.write("isommp41", 16, "latin1");
  const video = f.file("site/film.mp4", Buffer.concat([ftyp, Buffer.alloc(4000, 7)]));
  fs.truncateSync(video, 40 * 1024 * 1024);
  const url = await f.grant(f.pin("site/index.html"));
  const ended = await raw(f, sibling(url, "film.mp4"), {
    onResponse: (res) =>
      new Promise((resolve) => {
        assert.equal(res.statusCode, 200);
        res.once("data", () => {
          res.pause();
          f.application.identity.revoke(f.cookie.split("=")[1]);
          setTimeout(() => res.resume(), 200);
        });
        res.on("data", () => {});
        res.on("error", () => {});
        res.once("close", () => resolve(res.complete));
      }),
  });
  assert.equal(ended, false);
});
