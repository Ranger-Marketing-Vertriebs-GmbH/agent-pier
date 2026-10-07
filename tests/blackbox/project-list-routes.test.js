import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";

async function register(app, cwd) {
  return app.request("/api/memory/projects", { method: "POST", body: { cwd } });
}

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
  const response = await app.request("/api/memory/projects");
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
  const repositories = await (await app.request("/api/repositories")).json();
  assert.ok(Array.isArray(repositories.projects));
  const bus = await (await app.request("/api/agentbus")).json();
  assert.ok(Array.isArray(bus.projects));
});
