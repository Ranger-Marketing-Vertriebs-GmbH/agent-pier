import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import { dreamingSection } from "../../server/features/assistants/openclaw-config/dreaming.js";

function settings(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dreaming-settings-"));
  const store = new DreamingSettings({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

test("dreaming starts off at 03:00 UTC", (t) => {
  assert.deepEqual(settings(t).get(), {
    revision: 1,
    enabled: false,
    hour: 3,
    timeZone: "UTC",
  });
});

test("a save checks revision, hour and zone", (t) => {
  const store = settings(t);
  const input = { enabled: true, hour: 4, timeZone: "Europe/Berlin" };
  assert.deepEqual(store.save(input, 1), { revision: 2, ...input });
  assert.deepEqual(store.compiled(), input);
  assert.throws(() => store.save(input, 1), { status: 409 });
  for (const bad of [
    { ...input, hour: 24 },
    { ...input, hour: 2.5 },
    { ...input, timeZone: "Mars/Base" },
  ])
    assert.throws(() => store.save(bad, 2), { status: 400 });
  assert.equal(store.get().revision, 2);
});

test("the section moves the sweep hour, keeps deep on and names no model", () => {
  const section = dreamingSection({ enabled: true, hour: 5, timeZone: "Europe/Berlin" });
  assert.deepEqual(section, {
    enabled: true,
    frequency: "0 5 * * *",
    timezone: "Europe/Berlin",
    storage: { mode: "separate" },
  });
  assert.ok(!JSON.stringify(section).includes('"model"'));
  assert.deepEqual(dreamingSection({ enabled: false, hour: 5, timeZone: "UTC" }), {
    enabled: false,
  });
});
