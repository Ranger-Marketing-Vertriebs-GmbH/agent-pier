import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";

async function releaseServer(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-cache-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.resolve(import.meta.dirname, "../..");
  const release = path.join(temporary, "release");
  await fs.mkdir(path.join(release, "dist/assets"), { recursive: true });
  await fs.cp(path.join(project, "server"), path.join(release, "server"), {
    recursive: true,
  });
  await fs.symlink(
    path.join(project, "node_modules"),
    path.join(release, "node_modules"),
  );
  await fs.writeFile(path.join(release, "package.json"), '{"type":"module"}');
  const dist = path.join(release, "dist");
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>App</title>");
  await fs.writeFile(path.join(dist, "sw.js"), "// worker");
  await fs.writeFile(path.join(dist, "manifest.webmanifest"), "{}");
  await fs.writeFile(path.join(dist, "assets/index-D5b101IB.js"), "export default 1;");
  await fs.writeFile(path.join(dist, "assets/startup-0123456789ab.js"), "1;");
  await fs.writeFile(path.join(dist, "assets/App-Cu84xoQz.css"), "a{}");
  await fs.writeFile(path.join(dist, "assets/logo.png"), "png");
  const { registerResponses } = await import(
    pathToFileURL(path.join(release, "server/http/responses.js")).href
  );
  const { securityHeaders } = await import(
    pathToFileURL(path.join(release, "server/http/security.js")).href
  );
  const app = express();
  app.use(securityHeaders);
  registerResponses(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const html = { headers: { accept: "text/html" } };

test("hashed assets are immutable without public", async (t) => {
  const base = await releaseServer(t);
  for (const route of [
    "/assets/index-D5b101IB.js",
    "/assets/startup-0123456789ab.js",
    "/assets/App-Cu84xoQz.css",
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "max-age=31536000, immutable");
  }
});

test("unhashed static files revalidate", async (t) => {
  const base = await releaseServer(t);
  for (const route of ["/sw.js", "/manifest.webmanifest", "/assets/logo.png"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-cache", route);
    assert.ok(response.headers.get("etag"), route);
  }
});

test("app documents are never stored", async (t) => {
  const base = await releaseServer(t);
  for (const route of ["/", "/index.html", "/sessions/x/chat", "/artifacts/view/abc"]) {
    const response = await fetch(base + route, html);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-store", route);
  }
  const unknown = await fetch(base + "/unknown", html);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("cache-control"), "no-store");
});

test("missing assets and failed conditional or range requests are never cached", async (t) => {
  const base = await releaseServer(t);
  const missing = await fetch(base + "/assets/missing-AAAAAAAA.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  for (const headers of [{ "if-match": '"nope"' }, { range: "bytes=999999-" }]) {
    const response = await fetch(base + "/assets/index-D5b101IB.js", { headers });
    assert.ok(response.status >= 400, JSON.stringify(headers));
    assert.equal(
      response.headers.get("cache-control"),
      "no-store",
      JSON.stringify(headers),
    );
  }
});
