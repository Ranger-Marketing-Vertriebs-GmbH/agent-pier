import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  namesSecrets,
  secretsCall,
  secretsReadTools,
} from "../../server/features/assistants/team-plugin/secrets-guard.js";
import { registerToolGuard } from "../../server/features/assistants/team-plugin/tool-guard.js";

// An agent workspace on disk with its secrets file, a symbolic and a hard link to
// it from memory/, and an ordinary note.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-secrets-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, "a1");
  fs.mkdirSync(path.join(own, ".agentpier"), { recursive: true });
  fs.mkdirSync(path.join(own, "memory"));
  fs.writeFileSync(path.join(own, ".agentpier", "secrets.env"), "A='1'\n");
  fs.writeFileSync(path.join(own, "memory", "note.md"), "note\n");
  fs.symlinkSync("../.agentpier/secrets.env", path.join(own, "memory", "leak.md"));
  fs.linkSync(
    path.join(own, ".agentpier", "secrets.env"),
    path.join(own, "memory", "hard.md"),
  );
  return { roots: [root], own, agentId: "ap-a1" };
}

test("a read names the secrets folder in every spelling and through links", (t) => {
  const w = workspace(t);
  const secrets = path.join(w.own, ".agentpier", "secrets.env");
  for (const value of [
    ".agentpier/secrets.env",
    ".AgentPier/secrets.env",
    "./.agentpier/secrets.env",
    "memory/../.agentpier/secrets.env",
    ".agentpier\\secrets.env",
    "@.agentpier/secrets.env",
    ".agentpier/secrets.env</arg_value>>",
    secrets,
    pathToFileURL(secrets).href,
    pathToFileURL(secrets).href.replace("/.agentpier/", "/%2Eagentpier/"),
    pathToFileURL(secrets).href.replace("/.agentpier/", "/%2eAGENTPIER/"),
    ".agentpier",
    "memory/leak.md",
    "memory/hard.md",
    "/srv/elsewhere/.agentpier/secrets.env",
  ])
    for (const key of ["path", "file_path", "filePath", "pdf", "image"])
      assert.equal(namesSecrets({ [key]: value }, w), true, `${key} ${value}`);
  assert.equal(namesSecrets({ images: ["memory/note.md", "memory/leak.md"] }, w), true);
  assert.equal(namesSecrets({ pdfs: [pathToFileURL(secrets).href] }, w), true);
  for (const value of [
    "memory/note.md",
    "MEMORY.md",
    "notes/agentpier.md",
    "x.agentpier",
  ])
    assert.equal(namesSecrets({ path: value }, w), false, value);
  assert.equal(namesSecrets({}, w), false);
});

test("only a read of the folder asks AgentPier, which decides per session", async (t) => {
  const w = workspace(t);
  const asked = [];
  const bridge = (allow) => async (endpoint, body) => {
    asked.push({ endpoint, body });
    return { ok: true, json: async () => ({ allow }) };
  };
  const ctx = { agentId: "ap-a1", sessionKey: "agent:ap-a1:cron:job:run:r1" };
  const call = (params, answer) =>
    secretsCall({ toolName: "read", params }, ctx, bridge(answer), w.roots);
  assert.equal(await call({ path: "memory/note.md" }, false), undefined);
  assert.equal(asked.length, 0);
  const refused = await call({ path: ".agentpier/secrets.env" }, false);
  assert.equal(refused.block, true);
  assert.match(refused.blockReason, /secrets are not available in this run/);
  assert.deepEqual(asked[0], { endpoint: "/secrets-policy", body: ctx });
  assert.equal(await call({ path: "memory/leak.md" }, true), undefined);
  // No answer refuses.
  const down = await secretsCall(
    { toolName: "read", params: { path: ".agentpier/secrets.env" } },
    ctx,
    async () => {
      throw new Error("down");
    },
    w.roots,
  );
  assert.equal(down.block, true);
});

test("the tool guard registers the secrets read hook for every read tool", () => {
  const hooks = [];
  registerToolGuard({
    pluginConfig: { workspaces: "/w", url: "http://127.0.0.1:1", token: "t" },
    on: (name, fn, opts) => hooks.push({ name, opts }),
  });
  const matchers = hooks.map((h) => h.opts?.matcher).filter(Boolean);
  assert.ok(matchers.some((m) => m === secretsReadTools));
  for (const tool of ["read", "memory_get", "pdf", "view_image", "image"])
    assert.ok(secretsReadTools.includes(tool), tool);
});
