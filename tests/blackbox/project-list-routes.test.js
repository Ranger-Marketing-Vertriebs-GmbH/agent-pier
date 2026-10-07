import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";

async function register(app, cwd) {
  return app.request("/api/memory/projects", { method: "POST", body: { cwd } });
}

test("the home folder and collection folders cannot be registered as projects", async (t) => {
  const app = await applicationFixture(t);
  assert.equal((await register(app, app.home)).status, 422);
  const collection = path.join(app.root, "Projects");
  for (const name of ["one", "two"]) {
    await fs.mkdir(path.join(collection, name), { recursive: true });
    execFileSync("git", ["init", "-q", path.join(collection, name)]);
  }
  assert.equal((await register(app, collection)).status, 422);
  assert.equal((await register(app, path.join(collection, "one"))).status, 201);
  const listed = await (await app.request("/api/memory/projects")).json();
  assert.deepEqual(
    listed.projects.map((project) => path.basename(project.cwd)),
    ["one"],
  );
});

test("sessions in the home folder launch without project memory or a current project", async (t) => {
  const app = await applicationFixture(t);
  const services = app.application;
  const launch = { args: ["--keep"], env: { KEEP: "1" } };
  const prepared = await services.memoryIntegration.prepare({
    id: "home-session",
    account: services.accounts.get("local-claude"),
    cwd: app.home,
    launch,
  });
  assert.equal(prepared, launch);
  const tooled = await services.sessionMcp.prepare({
    id: "home-tools",
    account: services.accounts.get("local-codex"),
    cwd: app.home,
    launch: { args: [], env: {} },
    selection: {
      scopes: ["catalog:read"],
      currentProject: true,
      projectIds: [],
      accountIds: [],
      connectionIds: [],
    },
  });
  assert.equal(tooled.agentpierTools.enabled, true);
  services.sessionMcp.discard("home-tools");
  assert.deepEqual(services.memory.projects().projects, []);
});

test("listed projects carry their live origin remote without credentials", async (t) => {
  const app = await applicationFixture(t);
  const lab = path.join(app.root, "electronic-lab");
  const plain = path.join(app.root, "notes");
  await fs.mkdir(lab);
  await fs.mkdir(plain);
  assert.equal((await register(app, lab)).status, 201);
  assert.equal((await register(app, plain)).status, 201);
  execFileSync("git", ["init", "-q", lab]);
  execFileSync("git", [
    "-C",
    lab,
    "remote",
    "add",
    "origin",
    "https://x-token:secret@github.com/acme/electronic-lab.git",
  ]);
  // Only the projects hub asks for remotes; other readers get no git call.
  const plainList = await (await app.request("/api/memory/projects")).json();
  assert.ok(plainList.projects.every((project) => !("remote" in project)));
  const response = await app.request("/api/memory/projects?remotes=1");
  const text = await response.text();
  assert.equal(text.includes("secret"), false);
  const remotes = Object.fromEntries(
    JSON.parse(text).projects.map((project) => [
      path.basename(project.cwd),
      project.remote,
    ]),
  );
  assert.deepEqual(remotes, {
    "electronic-lab": "https://github.com/acme/electronic-lab.git",
    notes: "",
  });
  const repositories = await (await app.request("/api/repositories?remotes=1")).json();
  assert.ok(Array.isArray(repositories.projects));
  const bus = await (await app.request("/api/agentbus?remotes=1")).json();
  assert.ok(Array.isArray(bus.projects));
});
