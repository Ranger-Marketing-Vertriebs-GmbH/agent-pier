import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  fallbackStep,
  guessTransport,
  initialWizard,
  isDirty,
  nextStep,
  pasteLeft,
  pasteRefused,
  previousStep,
  reachable,
  resolveStep,
  saveValues,
  stageIndex,
  stages,
  stepOfField,
  stepOrder,
  wizardReducer,
} from "../../web/features/mcp-servers/wizard/wizard-state.js";
import { pasteLimit } from "../../web/features/mcp-servers/wizard/paste-parser.js";
import {
  sanitiseName,
  uniqueName,
} from "../../web/features/mcp-servers/wizard/server-name.js";

const run = (actions, state = initialWizard()) => actions.reduce(wizardReducer, state);

test("each path has its own step order and a package path alone has Install", () => {
  assert.deepEqual(stepOrder("package"), [
    "source",
    "package",
    "settings",
    "install",
    "connect",
    "done",
  ]);
  assert.deepEqual(stepOrder("remote"), [
    "source",
    "remote",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.deepEqual(stepOrder("command"), [
    "source",
    "command",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.deepEqual(stages("package"), ["source", "setup", "install", "connect"]);
  assert.deepEqual(stages("remote"), ["source", "setup", "connect"]);
  assert.equal(stageIndex("remote", "review"), 1);
  assert.equal(stageIndex("package", "install"), 2);
  assert.equal(stageIndex("command", "done"), 2);
});

test("choosing a path sets transport and source; only visited steps are reachable", () => {
  const state = run([{ type: "choose", path: "package" }]);
  assert.equal(state.draft.transport, "stdio");
  assert.equal(state.draft.source, "package");
  assert.equal(reachable(state, "package"), true);
  assert.equal(reachable(state, "settings"), false);
  assert.equal(resolveStep(state, "settings"), null);
  assert.equal(fallbackStep(state), "package");
  assert.equal(nextStep(state, "package"), "settings");
  const remote = run([{ type: "choose", path: "remote" }]);
  assert.equal(remote.draft.transport, "http");
});

test("after saving, the steps before the save are closed and done is final", () => {
  const saved = run([
    { type: "choose", path: "remote" },
    { type: "visit", step: "settings" },
    { type: "visit", step: "review" },
    { type: "saved", id: "s1" },
    { type: "visit", step: "connect" },
  ]);
  assert.equal(reachable(saved, "settings"), false);
  assert.equal(reachable(saved, "source"), false);
  assert.equal(reachable(saved, "review"), true);
  assert.equal(previousStep(saved, "connect"), "review");
  assert.equal(isDirty(saved), false);
  const done = run([{ type: "visit", step: "done" }, { type: "finished" }], saved);
  assert.equal(reachable(done, "connect"), false);
  assert.equal(fallbackStep(done), "done");
});

test("a fresh wizard on a deep address is lost; reset starts over", () => {
  const fresh = initialWizard();
  assert.equal(resolveStep(fresh, "settings"), null);
  assert.equal(resolveStep(fresh, undefined), "source");
  assert.equal(run([{ type: "lost" }]).notice, "lost");
  const typed = run([{ type: "choose", path: "command" }]);
  assert.equal(isDirty(typed), true);
  assert.deepEqual(run([{ type: "reset" }], typed), initialWizard());
});

test("a refused field belongs to the step that shows it; typing there clears it", () => {
  assert.equal(stepOfField("package", "packageVersion"), "package");
  assert.equal(stepOfField("package", "name"), "package");
  assert.equal(stepOfField("remote", "url"), "remote");
  assert.equal(stepOfField("command", "command"), "command");
  assert.equal(stepOfField("command", "env"), "settings");
  assert.equal(stepOfField("remote", "headers"), "settings");
  assert.equal(stepOfField("command", "cwd"), "settings");
  const refused = run([
    { type: "choose", path: "remote" },
    { type: "refused", fieldError: { field: "name", text: "taken" } },
  ]);
  assert.equal(
    run([{ type: "set", key: "url", value: "x" }], refused).fieldError.field,
    "name",
  );
  assert.equal(run([{ type: "set", key: "name", value: "x" }], refused).fieldError, null);
});

test("save values compose the Bearer prefix and drop headers without sign-in", () => {
  const row = (extra) => ({ key: "k", name: "Authorization", value: "abc", ...extra });
  const draft = { ...initialWizard().draft, transport: "http", signIn: "headers" };
  assert.equal(
    saveValues({ ...draft, headers: [row({ bearer: true })] }).headers[0].value,
    "Bearer abc",
  );
  assert.equal(
    saveValues({ ...draft, headers: [row({ bearer: true, value: "Bearer abc" })] })
      .headers[0].value,
    "Bearer abc",
  );
  assert.equal(saveValues({ ...draft, headers: [row()] }).headers[0].value, "abc");
  assert.deepEqual(
    saveValues({ ...draft, signIn: "none", headers: [row()] }).headers,
    [],
  );
  assert.equal(saveValues({ ...draft, signIn: "oauth" }).auth, "oauth");
  assert.deepEqual(saveValues(draft).clis, []);
  assert.equal(saveValues({ ...draft, argRows: ["a", "", "b"] }).args, "a\n\nb");
});

test("an address ending in /sse is guessed as SSE", () => {
  assert.equal(guessTransport("https://x.test/sse"), "sse");
  assert.equal(guessTransport("https://x.test/sse/"), "sse");
  assert.equal(guessTransport("https://x.test/mcp"), "http");
  assert.equal(guessTransport("not a url"), "http");
});

test("names are sanitised to the server rule and made unique", () => {
  assert.equal(sanitiseName("@acme/opnsense-mcp"), "acme-opnsense-mcp");
  assert.equal(sanitiseName("123 my.tool"), "my-tool");
  assert.equal(sanitiseName("ü"), "");
  assert.equal(sanitiseName("a".repeat(40)).length, 30);
  assert.equal(uniqueName("docs", ["docs", "docs-2"]), "docs-3");
  assert.equal(uniqueName("docs", []), "docs");
  assert.equal(uniqueName("a".repeat(30), ["a".repeat(30)]), `${"a".repeat(28)}-2`);
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), fc.array(fc.string()), (raw, taken) => {
      const name = uniqueName(sanitiseName(raw) || "server", taken);
      assert.match(name, /^[A-Za-z][A-Za-z0-9_-]{0,29}$/);
      assert.ok(!taken.includes(name));
    }),
  );
});

test("connect results are kept for Done", () => {
  const state = run([
    { type: "connected", results: [{ ok: true }], diff: { agents: [] }, consented: true },
  ]);
  assert.deepEqual(state.connect, {
    results: [{ ok: true }],
    diff: { agents: [] },
    consented: true,
  });
  assert.equal(initialWizard().connect, null);
});

test("paste is its own entry: Source → Paste → set-up → Settings", () => {
  const typed = run([
    { type: "via", via: "paste" },
    { type: "pasteText", text: "{}" },
  ]);
  assert.deepEqual(stepOrder(null, "paste"), ["source", "paste"]);
  assert.equal(reachable(typed, "paste"), true);
  assert.equal(isDirty(typed), true);
  const pasted = run(
    [
      {
        type: "pasted",
        draft: {
          path: "package",
          name: "opnsense",
          packageName: "opnsense-mcp-server",
          origin: "paste",
        },
      },
    ],
    typed,
  );
  assert.deepEqual(stepOrder(pasted.path, pasted.via), [
    "source",
    "paste",
    "package",
    "settings",
    "install",
    "connect",
    "done",
  ]);
  assert.equal(pasted.draft.transport, "stdio");
  assert.equal(pasted.draft.packageName, "opnsense-mcp-server");
  assert.equal(pasted.draft.origin, "paste");
  assert.equal(reachable(pasted, "settings"), true);
  assert.equal(previousStep(pasted, "settings"), "package");
  assert.equal(previousStep(pasted, "package"), "paste");
  assert.equal(run([{ type: "choose", path: "remote" }], pasted).via, null);
});

test("Add another server offers the next unfinished server of a pasted block", () => {
  const result = {
    ok: true,
    servers: [{ name: "a" }, { name: "b" }, { name: "c" }],
    warnings: [],
  };
  const state = run([
    { type: "via", via: "paste" },
    { type: "pasteText", text: "x" },
    { type: "pasteResult", result, index: 1 },
    { type: "pasted", index: 1, draft: { path: "command", name: "b" } },
  ]);
  assert.equal(state.paste.applied, 1);
  assert.equal(pasteLeft(state.paste), true);
  const kept = run([{ type: "reset", keepPaste: true }], state);
  assert.deepEqual(kept.paste, { text: "x", result, index: 0, applied: null, done: [1] });
  assert.equal(kept.via, "paste");
  assert.equal(reachable(kept, "paste"), true);
  const second = run(
    [
      { type: "pasted", index: 0, draft: { path: "command", name: "a" } },
      { type: "reset", keepPaste: true },
    ],
    kept,
  );
  assert.equal(second.paste.index, 2);
  assert.deepEqual(second.paste.done, [1, 0]);
  const last = run(
    [{ type: "pasted", index: 2, draft: { path: "command", name: "c" } }],
    second,
  );
  assert.equal(pasteLeft(last.paste), false);
  // Nothing left: a plain new wizard, the block is dropped.
  assert.deepEqual(run([{ type: "reset", keepPaste: true }], last), initialWizard());
  assert.deepEqual(run([{ type: "reset" }], state).paste, initialWizard().paste);
  // Choosing another server keeps what is done; reading a new block clears it.
  assert.deepEqual(
    run([{ type: "pasteResult", result, index: 2 }], kept).paste.done,
    [1],
  );
  const other = { ...result, servers: [{ name: "z" }] };
  assert.deepEqual(
    run([{ type: "pasteResult", result: other, index: 0 }], kept).paste.done,
    [],
  );
});

test("a pasted text is stored up to a hard cap so the parser can say it is too long", () => {
  const huge = "x".repeat(pasteLimit * 32);
  const stored = run([{ type: "pasteText", text: huge }]).paste.text;
  assert.ok(stored.length > pasteLimit);
  assert.ok(stored.length < huge.length);
});

test("an own command switches to the package it names", () => {
  const state = run([
    { type: "choose", path: "command" },
    { type: "set", key: "name", value: "everything" },
    {
      type: "set",
      key: "command",
      value: "npx -y @modelcontextprotocol/server-everything",
    },
    {
      type: "switchToPackage",
      values: {
        registry: "npm",
        packageName: "@modelcontextprotocol/server-everything",
        packageVersion: "",
        argRows: [],
        hints: { program: "everything" },
      },
    },
  ]);
  assert.equal(state.path, "package");
  assert.equal(state.via, null);
  assert.equal(state.draft.source, "package");
  assert.equal(state.draft.transport, "stdio");
  assert.equal(state.draft.name, "everything");
  assert.equal(state.draft.command, "");
  assert.equal(state.draft.packageName, "@modelcontextprotocol/server-everything");
  assert.equal(state.draft.hints.program, "everything");
  assert.deepEqual(state.visited, ["source", "package"]);
});

test("Add another server does not return to Paste when only refused servers remain", () => {
  const result = {
    ok: true,
    servers: [
      { name: "a" },
      { name: "b", refused: "noCommand" },
      { key: "c", refused: "invalidArgs" },
    ],
    warnings: [],
  };
  const state = run([
    { type: "via", via: "paste" },
    { type: "pasteResult", result, index: 0 },
    { type: "pasted", index: 0, draft: { path: "command", name: "a" } },
  ]);
  assert.equal(pasteLeft(state.paste), false);
  assert.deepEqual(pasteRefused(state.paste), ["b", "c"]);
  assert.deepEqual(run([{ type: "reset", keepPaste: false }], state), initialWizard());
});

test("the directory is its own entry: Source → Directory → set-up → Settings", () => {
  const state = run([
    { type: "via", via: "directory" },
    {
      type: "fromDirectory",
      draft: {
        path: "remote",
        name: "docs",
        url: "https://x.test/mcp",
        origin: "directory",
      },
    },
  ]);
  assert.deepEqual(stepOrder(state.path, state.via), [
    "source",
    "directory",
    "remote",
    "settings",
    "review",
    "connect",
    "done",
  ]);
  assert.equal(previousStep(state, "remote"), "directory");
  assert.equal(state.draft.origin, "directory");
  assert.equal(initialWizard().draft.directoryOrigin, null);
  assert.equal(initialWizard().draft.urlTemplate, null);
});
