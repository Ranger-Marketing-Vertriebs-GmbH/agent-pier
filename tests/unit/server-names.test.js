import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { serverMessagesReady } from "../../web/lib/server-messages.js";
import { localizeNames } from "../../web/lib/server-names.js";
import { nameMessageFields } from "../../server/features/sessions/session-creation.js";

const state = () => ({
  accounts: [
    {
      id: "local-codex",
      name: "Codex · Lokal",
      nameKey: "accounts.localAccountName",
      nameArgs: ["Codex"],
    },
    { id: "work", name: "Work · Lokal" },
  ],
  sessions: [
    {
      id: "s1",
      name: "Work · Anmeldung",
      nameKey: "sessions.loginName",
      nameArgs: ["Work"],
    },
    { id: "s2", name: "My session" },
  ],
});

test("generated names follow the UI language; typed names stay", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  const german = state();
  assert.deepEqual(
    localizeNames(german).accounts.map((a) => a.name),
    ["Codex · Lokal", "Work · Lokal"],
  );
  setLanguage("en", { persist: false });
  await serverMessagesReady();
  const english = localizeNames(german);
  assert.deepEqual(
    english.accounts.map((a) => a.name),
    ["Codex · Local", "Work · Lokal"],
  );
  assert.deepEqual(
    english.sessions.map((s) => s.name),
    ["Work · Sign-in", "My session"],
  );
  // Records without a key are the same objects.
  assert.equal(english.sessions[1], german.sessions[1]);
});

test("a state without generated names is returned as it is", () => {
  const plain = { accounts: [{ id: "a", name: "A" }], sessions: [] };
  assert.equal(localizeNames(plain), plain);
});

test("only a well-formed name message is stored with a session", () => {
  assert.deepEqual(nameMessageFields({ key: "sessions.loginName", args: ["Work"] }), {
    nameKey: "sessions.loginName",
    nameArgs: ["Work"],
  });
  assert.deepEqual(nameMessageFields(undefined), {});
  assert.deepEqual(nameMessageFields({ key: "no key", args: [] }), {});
  assert.deepEqual(nameMessageFields({ key: "a.b", args: [1] }), {});
});

test("the access mode says how AgentPier is reached and by how many users", async () => {
  const { accessMode } = await import("../../web/app/access-mode.js");
  const { accessView } =
    await import("../../server/features/sessions/workspace-state.js");
  assert.deepEqual(accessMode({}), { reach: "local", users: 0 });
  assert.deepEqual(accessMode({ access: { tailscale: true, users: 1 } }), {
    reach: "tailscale",
    users: 1,
  });
  assert.deepEqual(accessMode({ access: { network: true, tailscale: true } }), {
    reach: "network",
    users: 0,
  });
  assert.deepEqual(
    accessView({
      effectiveConfig: () => ({ network: { enabled: true }, remoteUrl: "" }),
      users: { list: () => [{ disabled: false }, { disabled: true }] },
    }),
    { network: true, tailscale: false, users: 1 },
  );
  assert.deepEqual(accessView({ config: { remoteUrl: "https://x.ts.net" } }), {
    network: false,
    tailscale: true,
    users: 0,
  });
});
