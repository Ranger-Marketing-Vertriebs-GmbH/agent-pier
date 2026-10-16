import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  fallbackStep,
  guessTransport,
  initialWizard,
  isDirty,
  nextStep,
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
