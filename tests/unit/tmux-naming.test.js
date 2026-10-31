import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, projectDir } from "../../server/lib/config.js";
import {
  newReleaseManifest,
  releaseManifest,
} from "../../server/features/operations/release-archive.js";
import {
  SESSION_PREFIX,
  sessionIdFromName,
  tmuxSocketPath,
} from "../../server/features/sessions/tmux-naming.js";
import { sessionPanes } from "../../server/features/system-status/system-status.js";

const variables = ["AGENTPIER_DATA_DIR", "AGENTPIER_PORT", "AGENTPIER_DEV"];

function environment(t, values) {
  const saved = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const key of variables) delete process.env[key];
  Object.assign(process.env, values);
}

test("AGENTPIER_* variables configure the data directory, port and dev origins", (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentpier-env-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  environment(t, {});
  let config = loadConfig();
  assert.equal(config.dataDir, path.join(projectDir, ".data"));
  assert.deepEqual(config.devOrigins, []);

  environment(t, {
    AGENTPIER_DATA_DIR: dataDir,
    AGENTPIER_PORT: "4392",
    AGENTPIER_DEV: "1",
  });
  config = loadConfig();
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.port, 4392);
  assert.equal(config.devOrigins.length, 2);
});

test("only agentpier-<id> names a session", () => {
  assert.equal(SESSION_PREFIX, "agentpier-");
  assert.equal(sessionIdFromName("agentpier-abc_1"), "abc_1");
  for (const name of [
    "other",
    "agentpier-",
    "agentpier-../x",
    "xagentpier-a",
    "agentpier-a b",
    "legacy-abc_1",
  ])
    assert.equal(sessionIdFromName(name), null, name);
});

test("each data directory gets its own private agentpier socket", (t) => {
  const first = mkdtempSync(path.join(tmpdir(), "agentpier-socket-"));
  const second = mkdtempSync(path.join(tmpdir(), "agentpier-socket-"));
  t.after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });
  const socket = tmuxSocketPath(first);
  assert.match(socket, /^\/tmp\/agentpier-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.equal(tmuxSocketPath(`${first}/./`), socket, "resolved before hashing");
  assert.notEqual(tmuxSocketPath(second), socket);
});

test("system status takes one pane per session and prefers a live one", async () => {
  const panes = await sessionPanes({
    tmux: async () =>
      [
        "agentpier-new|0|201",
        "agentpier-split|0|301",
        "agentpier-split|0|302",
        "agentpier-revived|1|401",
        "agentpier-revived|0|402",
        "agentpier-gone|1|501",
        "legacy-old|0|101",
        "other|0|5",
      ].join("\n"),
    metadata: async () => ({ name: "", tool: "codex" }),
  });
  assert.deepEqual(
    panes.map(({ id, pid }) => [id, pid]),
    [
      ["new", 201],
      ["split", 301],
      ["revived", 402],
      ["gone", 501],
    ],
  );
});

test("release manifests list the tmux name form this release understands", () => {
  const manifest = newReleaseManifest("9.9.9");
  assert.deepEqual(manifest.tmuxNames, ["agentpier"]);
  assert.deepEqual(releaseManifest(manifest), manifest);
});
