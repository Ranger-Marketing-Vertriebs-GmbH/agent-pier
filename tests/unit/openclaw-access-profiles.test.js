import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readStoredProfile,
  removeAccessProfile,
  writeAccessProfile,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-access-profiles.js";
import { openClawStore } from "../helpers/openclaw-store.js";

const credential = {
  access: "access-new",
  expires: 2e12,
  accountId: "acct",
  email: "owner@example.invalid",
  plan: "plus",
  residency: "eu",
};
const legacy = {
  type: "oauth",
  provider: "openai",
  access: "access-old",
  refresh: "refresh-old",
  expires: 1e12,
  email: "owner@example.invalid",
  displayName: "Personal",
};

for (const layout of ["state-db", "legacy-main"])
  test(`${layout}: the profile becomes access-only and nothing else changes`, (t) => {
    const other = { type: "api_key", provider: "anthropic", key: "k" };
    const { stateDir, read } = openClawStore(t, {
      layout,
      store: {
        version: 1,
        profiles: { "openai:owner@example.invalid": legacy, "anthropic:x": other },
        order: { openai: ["openai:owner@example.invalid"] },
      },
    });
    assert.deepEqual(readStoredProfile(stateDir, "openai:owner@example.invalid"), legacy);
    writeAccessProfile(stateDir, "openai:owner@example.invalid", credential);
    const store = read();
    assert.deepEqual(store.profiles["openai:owner@example.invalid"], {
      type: "oauth",
      provider: "openai",
      access: "access-new",
      expires: 2e12,
      accountId: "acct",
      email: "owner@example.invalid",
      chatgptPlanType: "plus",
    });
    assert.deepEqual(store.profiles["anthropic:x"], other);
    assert.deepEqual(store.order, { openai: ["openai:owner@example.invalid"] });
    removeAccessProfile(stateDir, "openai:owner@example.invalid");
    assert.deepEqual(Object.keys(read().profiles), ["anthropic:x"]);
    assert.equal(readStoredProfile(stateDir, "openai:owner@example.invalid"), null);
  });

test("a first write creates the store row; unknown layouts and shapes are refused", (t) => {
  const empty = openClawStore(t);
  writeAccessProfile(empty.stateDir, "openai:a", credential);
  assert.equal(empty.read().version, 1);
  assert.equal(empty.read().profiles["openai:a"].refresh, undefined);

  // No auth write yet and no legacy store: the state database becomes the owner.
  const fresh = openClawStore(t, { layout: "none" });
  assert.equal(readStoredProfile(fresh.stateDir, "openai:a"), null);
  writeAccessProfile(fresh.stateDir, "openai:a", credential);
  assert.equal(fresh.read().profiles["openai:a"].access, "access-new");
  assert.deepEqual(fresh.owner(), { location: "state-db" });

  const strangeOwner = openClawStore(t, { owner: { location: "elsewhere" } });
  assert.throws(() => writeAccessProfile(strangeOwner.stateDir, "openai:a", credential), {
    code: "UNKNOWN_LAYOUT",
  });
  const strangeStore = openClawStore(t, { store: { version: 2, profiles: {} } });
  assert.throws(() => writeAccessProfile(strangeStore.stateDir, "openai:a", credential), {
    code: "UNKNOWN_SHAPE",
  });
  const foreign = openClawStore(t, {
    store: {
      version: 1,
      profiles: { "openai:a": { type: "api_key", provider: "openai" } },
    },
  });
  assert.throws(() => writeAccessProfile(foreign.stateDir, "openai:a", credential), {
    code: "UNKNOWN_PROFILE",
  });
  const fenced = openClawStore(t, {
    store: {
      version: 1,
      profiles: {
        "openai:a": { ...legacy, access: "openclaw-oauth-refresh-fence:x" },
      },
    },
  });
  assert.throws(() => writeAccessProfile(fenced.stateDir, "openai:a", credential), {
    code: "REFRESH_IN_PROGRESS",
  });
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-none-"));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  assert.throws(() => writeAccessProfile(missing, "openai:a", credential), {
    code: "STORE_MISSING",
  });
});
