import test from "node:test";
import assert from "node:assert/strict";
import {
  displayEnvironment,
  runtimeEnvironment,
} from "../../server/features/assistants/runtime-config.js";
import {
  webToolsSections,
  webToolsSignatures,
  webToolsSnapshot,
} from "../../server/features/assistants/openclaw-config/web-tools.js";
import {
  guardGatedTools,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";
import { WriteGuardReapply } from "../../server/features/assistants/write-guard-reapply.js";
import {
  agentProfileName,
  browserProfileMap,
  browserProfilesPatch,
  nextBrowserProfiles,
} from "../../server/features/assistants/openclaw-config/browser-profiles.js";

const port = 30000;
const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const visibleApp = {
  available: true,
  name: "Brave",
  executablePath: brave,
  visible: { available: true },
};
const chromeOnly = {
  available: true,
  name: "Chrome",
  executablePath: "/c",
  visible: { available: false, reason: "noApp" },
};
const agent = (id, extra = {}) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { browser: true },
  ...extra,
});
const member = {
  id: "m1",
  runtimeAgentId: "ap-m1",
  teamMemberId: "m1",
  lifetime: "task",
  parentAssistantId: "b",
  inherited: { capabilities: { browser: true }, skills: [], shell: "off", ssh: false },
};
const sections = (profiles, browser = visibleApp) =>
  webToolsSections({ profiles, webTools: { browser }, port });

test("every agent with the browser gets its own persistent profile and CDP port", () => {
  const { browser } = sections([agent("b"), agent("a"), agent("c", { archivedAt: "x" })]);
  assert.deepEqual(Object.keys(browser.profiles), [
    "user",
    "chrome",
    "member-1",
    "member-2",
    "member-3",
    "member-visible-1",
    "member-visible-2",
    "member-visible-3",
    "agent-a",
    "agent-b",
  ]);
  assert.deepEqual(browser.profiles["agent-a"], {
    driver: "openclaw",
    cdpPort: port + 20,
    headless: true,
  });
  assert.equal(browser.profiles["agent-b"].cdpPort, port + 21);
  // Isolation stays as before: no evaluation, no import, default SSRF, no noSandbox.
  assert.equal(browser.evaluateEnabled, false);
  assert.equal(browser.allowSystemProfileImport, false);
  assert.equal(browser.ssrfPolicy, undefined);
  assert.equal(browser.noSandbox, undefined);
  assert.deepEqual(browser.extraArgs, ["--use-mock-keychain"]);
  assert.equal(browser.executablePath, brave);
  for (const profile of Object.values(browser.profiles))
    assert.equal(profile.driver, "openclaw");
});

test("a visible window needs the agent's setting and a separate agent browser app", () => {
  const visible = agent("a", { browserVisible: true });
  const { browser } = sections([visible, agent("b")]);
  assert.equal(browser.profiles["agent-a"].headless, false);
  assert.equal(browser.profiles["agent-b"].headless, true);
  // Members of a visible lead have visible slots of their own.
  for (const n of [1, 2, 3]) {
    assert.equal(browser.profiles[`member-${n}`].headless, true);
    assert.equal(browser.profiles[`member-visible-${n}`].headless, false);
  }
  assert.equal(browser.profiles["member-visible-1"].cdpPort, port + 17);
  // The owner's Chrome is never launched visibly.
  const fallback = sections([visible], chromeOnly).browser;
  assert.equal(fallback.profiles["agent-a"].headless, true);
  assert.equal(fallback.profiles["member-visible-1"], undefined);
  assert.equal(
    sections([visible], { ...visibleApp, visible: { available: false } }).browser
      .profiles["agent-a"].headless,
    true,
  );
});

test("temporary members never get a profile of their own in the configuration", () => {
  const map = browserProfileMap({
    profiles: [agent("b"), member],
    browser: visibleApp,
    port,
  });
  assert.equal(map["agent-m1"], undefined);
  assert.equal(map["agent-b"].agentId, "b");
  assert.equal(map["member-1"].slot, true);
  // The slots exist without any agent, so a lead switching on needs no restart.
  assert.deepEqual(
    Object.keys(browserProfileMap({ profiles: [member], browser: visibleApp, port })),
    [1, 2, 3]
      .flatMap((n) => [`member-${n}`])
      .concat([1, 2, 3].map((n) => `member-visible-${n}`)),
  );
  assert.equal(agentProfileName("A1B2"), "agent-a1b2");
  assert.equal(agentProfileName("x".repeat(80)), null);
});

test("switching a window or the browser on or off leaves the global sections", () => {
  const snapshot = (profiles) =>
    webToolsSnapshot({ profiles, webTools: { browser: visibleApp }, port }).signatures
      .browser;
  const off = snapshot([agent("a")]);
  assert.equal(snapshot([agent("a", { browserVisible: true })]), off);
  assert.equal(snapshot([agent("a"), agent("b")]), off);
  assert.equal(snapshot([]), off);
  // A browser app that can show windows, or none, does change them.
  assert.notEqual(webToolsSignatures({ webTools: { browser: chromeOnly } }).browser, off);
});

test("a live change moves only the agent's own profile and keeps every port", () => {
  const start = browserProfileMap({
    profiles: [agent("a"), agent("c")],
    browser: visibleApp,
    port,
  });
  // "b" sorts between them but takes the next free port; nobody else moves.
  const next = nextBrowserProfiles({
    current: start,
    profiles: [agent("a", { browserVisible: true }), agent("b"), agent("c")],
    visibleApp: true,
    port,
  });
  assert.equal(next["agent-a"].cdpPort, start["agent-a"].cdpPort);
  assert.equal(next["agent-c"].cdpPort, start["agent-c"].cdpPort);
  assert.equal(next["agent-b"].cdpPort, port + 22);
  assert.deepEqual(browserProfilesPatch(start, next), {
    "agent-a": { driver: "openclaw", cdpPort: port + 20, headless: false },
    "agent-b": { driver: "openclaw", cdpPort: port + 22, headless: true },
  });
  // "a" switches off: its profile goes, and its port is free again.
  const later = nextBrowserProfiles({
    current: next,
    profiles: [agent("b"), agent("c"), agent("d")],
    visibleApp: true,
    port,
  });
  assert.deepEqual(browserProfilesPatch(next, later), {
    "agent-d": { driver: "openclaw", cdpPort: port + 20, headless: true },
    "agent-a": null,
  });
  assert.equal(browserProfilesPatch(later, later), null);
});

test("the start snapshot keeps the profiles with the ports this start uses", () => {
  const snapshot = webToolsSnapshot({
    profiles: [agent("a", { browserVisible: true })],
    webTools: { browser: visibleApp, searchPlugins: {} },
    port,
  });
  assert.equal(snapshot.browserProfiles["agent-a"].cdpPort, port + 20);
  assert.equal(snapshot.browserProfiles["agent-a"].headless, false);
  assert.equal(snapshot.visibleBrowser, true);
  // What a removal of the managed browser checks against.
  assert.equal(snapshot.browserExecutable, brave);
  assert.equal(snapshot.port, port);
  const none = webToolsSnapshot({
    profiles: [],
    webTools: { browser: { available: false } },
    port,
  });
  assert.deepEqual(none.browserProfiles, {});
});

test("the Gateway gets the owner's display, and nothing when there is none", () => {
  const paths = { home: "/h", tmp: "/t", state: "/s", config: "/c" };
  const env = runtimeEnvironment(paths, "/node/bin/node", {
    PATH: "/x",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.deepEqual(displayEnvironment({ DISPLAY: "", PATH: "/x" }), {});
  assert.equal(
    runtimeEnvironment(paths, "/node/bin/node", { PATH: "/x" }).DISPLAY,
    undefined,
  );
});

test("the browser waits for the proven tool guard, like guarded writes", () => {
  const assistant = agent("a");
  const tools = (guard) => profileTools(assistant, true, true, guard, { browser: true });
  assert.equal(tools(false).includes("browser"), false);
  assert.equal(tools(true).includes("browser"), true);
  assert.ok(guardGatedTools.includes("browser"));
  const lead = agent("b", { capabilities: { browser: true, memory: true } });
  const reapply = new WriteGuardReapply({
    assistants: {
      store: {
        listAssistants: () => [agent("a"), lead, agent("c", { capabilities: {} })],
      },
    },
    live: () => true,
    generation: () => 1,
  });
  assert.deepEqual(reapply.remaining(), ["a", "b"]);
});
