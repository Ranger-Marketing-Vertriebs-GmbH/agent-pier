import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionActivity,
  SessionActivity,
} from "../../server/features/sessions/session-activity.js";
const claude = (spinner = "") =>
  `${spinner}\n\n────────────────────────\n❯ \n────────────────────────\n  Opus 5 · Claude\n  ⏵⏵ auto mode on (shift+tab to cycle)`;
const spin = (glyph = "✽", seconds = 3) =>
  `\x1b[38;2;215;119;87m${glyph} Crystallizing… \x1b[38;2;153;153;153m(${seconds}s · ↓ 1k tokens)\x1b[39m`;
const codex = (status = "") =>
  `${status}\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt-6-astra high · ~/project`;
const opencode = (footer = "ctrl+p commands") =>
  `Assistant text\n┃ Build · Claude Sonnet\n┃ Ask anything\n╹━━━━━━━━━━━━━━━━\n ${footer}`;
test("activity parses native composer/footer states and approvals without treating transcript text as activity", () => {
  assert.equal(parseSessionActivity("codex", codex()).state, "idle");
  assert.equal(
    parseSessionActivity(
      "codex",
      codex("• Working \x1b[2m(12s • esc to interrupt)\x1b[0m"),
    ).state,
    "working",
  );
  assert.equal(parseSessionActivity("claude", claude(spin())).state, "working");
  assert.equal(parseSessionActivity("claude", claude()).state, "idle");
  assert.equal(parseSessionActivity("opencode", opencode()).state, "idle");
  assert.equal(
    parseSessionActivity("opencode", opencode("⣷ esc interrupt       ctrl+p commands"))
      .state,
    "working",
  );
  assert.equal(
    parseSessionActivity(
      "codex",
      "Do you want to run this command?\n› 1. Yes\n  2. No\nPress enter to confirm or esc to cancel",
    ).state,
    "waiting",
  );
  assert.equal(
    parseSessionActivity(
      "opencode",
      "Permission required\nAllow once   Allow always   Reject\n⇆ select    enter confirm",
    ).state,
    "waiting",
  );
  for (const tool of ["claude", "codex", "opencode"])
    assert.equal(
      parseSessionActivity(tool, "The docs say esc to interrupt and Working (12s)").state,
      "unknown",
    );
  assert.equal(
    parseSessionActivity(
      "codex",
      codex(
        "Quoted example: • Working (12s • esc to interrupt)\nThen the assistant finished.",
      ),
    ).state,
    "idle",
  );
  assert.equal(
    parseSessionActivity("claude", claude(`${spin()}\nThe spinner above was quoted.`))
      .state,
    "idle",
  );
  assert.equal(
    parseSessionActivity("claude", claude("✽ Crystallizing… (3s · ↓ 1k tokens)")).state,
    "idle",
  );
  assert.equal(
    parseSessionActivity("codex", codex("• Working (12s • esc to interrupt)")).state,
    "unknown",
  );
  assert.equal(
    parseSessionActivity(
      "codex",
      codex().replace("Ask Codex to do anything", "esc to interrupt"),
    ).state,
    "idle",
  );
});
test("Claude work requires a changing native status; frozen evidence expires instead of staying working", async () => {
  let now = 1000,
    screen = claude(spin());
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => screen,
    cacheMs: 0,
    now: () => now,
    staleMs: 8000,
  });
  const session = { id: "one", tool: "claude", status: "running" };
  assert.equal((await activity.read(session)).state, "unknown");
  now += 3000;
  screen = claude(spin("✢", 6));
  assert.equal((await activity.read(session)).state, "working");
  now += 9000;
  assert.equal((await activity.read(session)).state, "unknown");
  screen = claude();
  assert.equal((await activity.read(session)).state, "idle");
});
test("read caches and shares pending captures, limits concurrency, and clears working on capture failure or stopped status", async () => {
  let active = 0,
    max = 0,
    calls = 0,
    fail = false;
  let now = 0;
  const activity = new SessionActivity({
    sessions: {},
    cacheMs: 2000,
    now: () => now,
    concurrency: 2,
    screen: async () => {
      calls++;
      active++;
      max = Math.max(active, max);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (fail) throw Error("capture failed");
      return codex("• Working \x1b[2m(12s • esc to interrupt)\x1b[0m");
    },
  });
  const sessions = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    tool: "codex",
    status: "running",
  }));
  const [first, second] = await Promise.all([
    activity.enrich(sessions),
    activity.enrich(sessions),
  ]);
  assert.equal(calls, 8);
  assert.ok(max <= 2);
  assert.ok(first.every((x) => x.activity.state === "working"));
  assert.deepEqual(first, second);
  await activity.enrich(sessions);
  assert.equal(calls, 8);
  now += 3000;
  fail = true;
  assert.equal((await activity.read(sessions[0])).state, "unknown");
  assert.equal(
    (await activity.read({ ...sessions[0], status: "stopped" })).state,
    "stopped",
  );
  const before = calls;
  assert.equal(
    (await activity.read({ id: "shell", tool: "shell", status: "running" })).state,
    "unknown",
  );
  assert.equal(
    (
      await activity.read({
        id: "login",
        tool: "claude",
        purpose: "login",
        status: "running",
      })
    ).state,
    "unknown",
  );
  assert.equal(calls, before);
});
test("oversized captures and unknown dialogs stay unknown; parser strips styled blank rows and never exposes screen contents", async () => {
  assert.equal(
    parseSessionActivity("claude", "x".repeat(256 * 1024 + 1)).state,
    "unknown",
  );
  assert.equal(
    parseSessionActivity("opencode", "Select provider      esc\nPrivate provider config")
      .state,
    "unknown",
  );
  assert.equal(
    parseSessionActivity("codex", codex() + "\n\x1b[0m   \n\x1b[0m").state,
    "idle",
  );
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => claude(spin()),
  });
  const item = await activity.read({ id: "one", tool: "claude", status: "running" });
  assert.equal(JSON.stringify(item).includes("Crystallizing"), false);
  assert.equal(Object.hasOwn(item, "evidence"), false);
});
test("Codex and OpenCode working evidence expires when frozen and resumes only after a changed status", async () => {
  for (const tool of ["codex", "opencode"]) {
    let now = 1000;
    let screen =
      tool === "codex"
        ? codex("• Working \x1b[2m(12s • esc to interrupt)\x1b[0m")
        : opencode("⣷ esc interrupt       ctrl+p commands");
    const activity = new SessionActivity({
      sessions: {},
      screen: async () => screen,
      cacheMs: 0,
      now: () => now,
      staleMs: 10000,
    });
    const session = { id: tool, tool, status: "running" };
    assert.equal((await activity.read(session)).state, "working");
    now += 120000;
    assert.equal((await activity.read(session)).state, "unknown");
    screen = screen.replace("12s", "132s").replace("⣷", "⣯");
    assert.equal((await activity.read(session)).state, "working");
  }
});
test("quoted confirmation shortcuts without a native dialog do not imply waiting", () => {
  for (const tool of ["codex", "claude"]) {
    assert.equal(
      parseSessionActivity(tool, "The docs quote: enter to confirm or esc to cancel")
        .state,
      "unknown",
    );
    assert.equal(
      parseSessionActivity(tool, "enter to confirm or esc to cancel").state,
      "unknown",
    );
  }
});
