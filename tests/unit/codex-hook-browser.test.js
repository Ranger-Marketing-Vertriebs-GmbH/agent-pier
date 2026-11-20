import test from "node:test";
import assert from "node:assert/strict";
import {
  hookBrowserScreen,
  refreshHookBrowser,
} from "../../server/features/requests/codex-hook-browser.js";
import { answerHookTrust } from "../../server/features/requests/codex-hook-trust.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import {
  browserList,
  browserDetail,
  browserDetailTrusted,
  browserListTrusted,
} from "../fixtures/requests/codex-hook-browser.js";

const composer =
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n  gpt-5 · /fixture\n";

test("the hooks browser of Codex 0.169 is recognized in its list and detail views", () => {
  assert.deepEqual(hookBrowserScreen(browserList), {
    view: "list",
    count: 2,
    events: ["SessionStart", "UserPromptSubmit"],
  });
  assert.deepEqual(hookBrowserScreen(browserDetail), {
    view: "detail",
    count: 1,
    events: ["SessionStart"],
  });
  assert.deepEqual(hookBrowserScreen(browserDetailTrusted), {
    view: "detail",
    count: 0,
    events: [],
  });
  assert.deepEqual(hookBrowserScreen(browserListTrusted), {
    view: "list",
    count: 0,
    events: [],
  });
});

test("a narrow terminal that wraps the browser's text still reads as the browser", () => {
  const narrow = browserList
    .replace(
      "Lifecycle hooks from config and enabled plugins.",
      "Lifecycle hooks from config and enabled\n  plugins.",
    )
    .replace(
      "⚠ 2 hooks need review before they can run.",
      "⚠ 2 hooks need review before they\n  can run.",
    );
  assert.equal(hookBrowserScreen(narrow)?.count, 2);
});

test("prose about hooks and a composer below the browser are not the browser", () => {
  assert.equal(hookBrowserScreen(browserList + "\n" + composer), null);
  assert.equal(hookBrowserScreen("  Hooks\n  Something else.\n\n  esc close\n"), null);
  assert.equal(hookBrowserScreen(""), null);
  assert.equal(hookBrowserScreen(null), null);
  assert.equal(hookBrowserScreen("x".repeat(70000)), null);
});

test("a browser with hooks to review holds chat input; one without reads as a dialog", () => {
  const tui = cliDriver("codex").tui;
  assert.ok(tui.blockingScreen(browserList, {}));
  assert.ok(tui.blockingScreen(browserDetail, {}));
  assert.equal(tui.blockingScreen(browserListTrusted, {}), null);
  const pane = { cursorX: 0, cursorY: 0, width: 140, height: 40 };
  for (const raw of [
    browserList,
    browserDetail,
    browserListTrusted,
    browserDetailTrusted,
  ])
    assert.deepEqual(tui.promptState({ raw, pane }), { state: "dialog" });
});

// A terminal that behaves like Codex's browser: Escape leaves a detail view for the
// list and closes the list; `t` trusts every hook the list shows.
function browserFixture(start = "list") {
  let view = start,
    trusted = false;
  const keys = [];
  const entry = {
    id: "request",
    sessionId: "one",
    accountId: "account",
    hookCount: 2,
    launchIdentity: "launch",
  };
  const render = () =>
    view === "closed"
      ? composer
      : view === "detail"
        ? trusted
          ? browserDetailTrusted
          : browserDetail
        : trusted
          ? browserListTrusted
          : browserList;
  const control = {
    session: { accountId: "account", tool: "codex", nativeRequests: { enabled: true } },
    screen: async () => render(),
    keys: async (values) => {
      keys.push(...values);
      for (const key of values) {
        if (key === "Escape") view = view === "detail" ? "list" : "closed";
        if (key === "t" && view === "list") trusted = true;
      }
    },
  };
  const broker = {
    entries: new Map([[entry.id, entry]]),
    launchIdentity: async () => "launch",
    sessions: { control: async (_id, operation) => operation(control) },
  };
  return { broker, entry, keys, state: () => ({ view, trusted }) };
}

test("trusting from the card trusts all hooks in the list view and closes the browser", async () => {
  for (const start of ["list", "detail"]) {
    const f = browserFixture(start);
    await answerHookTrust(f.broker, f.entry, "trust");
    assert.deepEqual(
      f.keys,
      start === "detail" ? ["Escape", "t", "Escape"] : ["t", "Escape"],
    );
    assert.deepEqual(f.state(), { view: "closed", trusted: true });
  }
});

test("skipping from the card closes the browser without trusting anything", async () => {
  for (const start of ["list", "detail"]) {
    const f = browserFixture(start);
    await answerHookTrust(f.broker, f.entry, "skip");
    assert.deepEqual(f.keys, start === "detail" ? ["Escape", "Escape"] : ["Escape"]);
    assert.deepEqual(f.state(), { view: "closed", trusted: false });
  }
});

test("a replaced launch refuses the browser answer before any key", async () => {
  const f = browserFixture();
  f.broker.launchIdentity = async () => "replacement";
  await assert.rejects(answerHookTrust(f.broker, f.entry, "trust"), { status: 409 });
  assert.deepEqual(f.keys, []);
});

function brokerFixture(screen) {
  const events = [];
  const session = {
    id: "one",
    tool: "codex",
    accountId: "account",
    cwd: "/fixture",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const broker = {
    entries: new Map(),
    launchIdentity: async () => "launch",
    emit: (entry, type) => events.push([type, entry.id]),
    expired: (entry, cause) => events.push(["expired", entry.id, cause]),
    sessions: {
      get: async () => session,
      control: async (_id, operation) =>
        operation({ session, screen: async () => screen() }),
    },
  };
  return { broker, events, session };
}

test("an open browser with hooks to review becomes one hook-trust card", async () => {
  let raw = browserList;
  const f = brokerFixture(() => raw);
  await refreshHookBrowser(f.broker, "one");
  await refreshHookBrowser(f.broker, "one");
  const entries = [...f.broker.entries.values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].presentation, "codexHookTrust");
  assert.equal(entries[0].local, true);
  assert.equal(entries[0].hookCount, 2);
  assert.equal(entries[0].launchIdentity, "launch");
  assert.deepEqual(
    entries[0].options.map((option) => option.id),
    ["trust", "skip"],
  );
  assert.match(entries[0].subject.command, /SessionStart\nUserPromptSubmit/);
  assert.deepEqual(f.events, [["request.created", entries[0].id]]);
  // Closed in the terminal: the card expires on the next read.
  raw = composer;
  await refreshHookBrowser(f.broker, "one");
  assert.equal(f.broker.entries.size, 0);
  assert.deepEqual(f.events.at(-1), ["expired", entries[0].id, "startup"]);
});

test("no card for a browser without reviews, another CLI or a pending startup card", async () => {
  const trusted = brokerFixture(() => browserListTrusted);
  await refreshHookBrowser(trusted.broker, "one");
  assert.equal(trusted.broker.entries.size, 0);
  const claude = brokerFixture(() => browserList);
  claude.session.tool = "claude";
  await refreshHookBrowser(claude.broker, "one");
  assert.equal(claude.broker.entries.size, 0);
  const startup = brokerFixture(() => browserList);
  startup.broker.entries.set("rpc", {
    id: "rpc",
    sessionId: "one",
    presentation: "codexHookTrust",
  });
  await refreshHookBrowser(startup.broker, "one");
  assert.deepEqual([...startup.broker.entries.keys()], ["rpc"]);
});
