import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  readAssistantFeature,
  writeAssistantFeature,
} from "../../server/features/assistants/assistant-feature.js";

function dataDirectory(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "assistant-feature-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return { root, dataDir };
}
const featureFile = (dataDir) => path.join(dataDir, "assistant-feature.json");

test("a fresh data directory keeps assistants dormant without creating storage", (t) => {
  const { dataDir } = dataDirectory(t);
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: false, error: null });
  assert.equal(fs.existsSync(path.join(dataDir, "assistants")), false);
  assert.equal(fs.existsSync(featureFile(dataDir)), false);
});

test("an install with an enabled assistant runtime migrates to an enabled feature", (t) => {
  const { dataDir } = dataDirectory(t);
  fs.mkdirSync(path.join(dataDir, "assistants"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(dataDir, "assistants", "settings.json"),
    JSON.stringify({ enabled: true }),
  );
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: true, error: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(featureFile(dataDir), "utf8")), {
    enabled: true,
  });
});

test("an install with stored assistant records migrates to an enabled feature", (t) => {
  const { dataDir } = dataDirectory(t);
  const store = new AssistantStore({ dataDir });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run("existing", 1, JSON.stringify({ id: "existing", name: "Home" }));
  store.close();
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: true, error: null });
  assert.equal(JSON.parse(fs.readFileSync(featureFile(dataDir), "utf8")).enabled, true);
});

test("an assistant database without records stays dormant", (t) => {
  const { dataDir } = dataDirectory(t);
  new AssistantStore({ dataDir }).close();
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: false, error: null });
  assert.equal(fs.existsSync(featureFile(dataDir)), false);
});

test("an explicit owner choice wins over migration evidence", (t) => {
  const { dataDir } = dataDirectory(t);
  fs.mkdirSync(path.join(dataDir, "assistants"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(dataDir, "assistants", "settings.json"),
    JSON.stringify({ enabled: true }),
  );
  writeAssistantFeature(dataDir, { enabled: false });
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: false, error: null });
  writeAssistantFeature(dataDir, { enabled: true });
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: true, error: null });
});

test("a symlinked assistant folder reports a stable diagnostic without a path", (t) => {
  const { root, dataDir } = dataDirectory(t);
  const target = path.join(root, "elsewhere");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "settings.json"), JSON.stringify({ enabled: true }));
  fs.symlinkSync(target, path.join(dataDir, "assistants"));
  const state = readAssistantFeature(dataDir);
  assert.deepEqual(state, { enabled: false, error: "ASSISTANT_STORAGE_UNSAFE" });
  assert.equal(fs.existsSync(featureFile(dataDir)), false);
  writeAssistantFeature(dataDir, { enabled: true });
  assert.deepEqual(readAssistantFeature(dataDir), {
    enabled: true,
    error: "ASSISTANT_STORAGE_UNSAFE",
  });
  assert.deepEqual(fs.readdirSync(target), ["settings.json"]);
});

test("a stale assistant folder owned by another user reports a diagnostic", (t) => {
  const { dataDir } = dataDirectory(t);
  fs.mkdirSync(path.join(dataDir, "assistants"), { mode: 0o700 });
  const uid = process.getuid();
  t.mock.method(process, "getuid", () => uid + 1);
  assert.deepEqual(readAssistantFeature(dataDir), {
    enabled: false,
    error: "ASSISTANT_STORAGE_UNSAFE",
  });
});

test("a file in place of the assistant folder reports a diagnostic", (t) => {
  const { dataDir } = dataDirectory(t);
  fs.writeFileSync(path.join(dataDir, "assistants"), "not a folder");
  assert.deepEqual(readAssistantFeature(dataDir), {
    enabled: false,
    error: "ASSISTANT_STORAGE_UNSAFE",
  });
});

test("a damaged feature file falls back to migration evidence", (t) => {
  const { dataDir } = dataDirectory(t);
  fs.writeFileSync(featureFile(dataDir), "{not json");
  assert.deepEqual(readAssistantFeature(dataDir), { enabled: false, error: null });
});
