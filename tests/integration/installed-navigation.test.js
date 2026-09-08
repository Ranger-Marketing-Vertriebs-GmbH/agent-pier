import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";

// Reproduce the versioned install layout: development checkouts do not have
// the hidden ancestor that made sendFile reject otherwise valid document paths.
test("installed app deep links survive hidden installation ancestors", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-navigation-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.resolve(import.meta.dirname, "../..");
  const release = path.join(temporary, ".local/share/agentpier/releases/1.0.3");
  await fs.mkdir(path.join(release, "dist/assets"), { recursive: true });
  await fs.cp(path.join(project, "server"), path.join(release, "server"), {
    recursive: true,
  });
  await fs.symlink(
    path.join(project, "node_modules"),
    path.join(release, "node_modules"),
  );
  await fs.writeFile(path.join(release, "package.json"), '{"type":"module"}');
  const shell = "<!doctype html><title>Installed AgentPier</title>";
  await fs.writeFile(path.join(release, "dist/index.html"), shell);
  await fs.writeFile(path.join(release, "dist/.private"), "private fixture");
  await fs.writeFile(path.join(release, "dist/assets/app.js"), "export default 1;");
  const { registerResponses } = await import(
    pathToFileURL(path.join(release, "server/http/responses.js")).href
  );
  const app = express();
  registerResponses(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of [
    "/",
    "/accounts",
    "/repositories",
    "/settings/audit?page=2",
    "/sessions/example/chat",
    "/sessions/example/terminal",
    "/plugins/local-claude",
    "/extensions/local-codex",
    "/memory/example",
    "/pipelines/profiles/example",
    "/agentbus/messages/example",
  ]) {
    const response = await fetch(base + route, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(await response.text(), shell, route);
  }
  for (const route of ["/api/missing", "/assets/missing.js", "/.private", "/unknown"]) {
    const response = await fetch(base + route, { headers: { accept: "text/html" } });
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /private fixture/);
  }
  const asset = await fetch(base + "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "export default 1;");
});
