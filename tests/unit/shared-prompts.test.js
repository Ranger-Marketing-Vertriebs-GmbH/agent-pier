import test from "node:test";
import assert from "node:assert/strict";
import { sharedAgentAdapter } from "../../server/features/assistants/runtimes/openclaw/shared-prompts.js";

// Every prompt the sessions and routines sub-ports carry for an agent shared with
// users, on the current client or a named connection, goes out cleaned.
const recorder = (calls, name) => ({
  send: async (input) => calls.push([name, "send", input]),
  add: async (input) => calls.push([name, "add", input]),
  update: async (input) => calls.push([name, "update", input]),
  history: async () => "kept",
});
const port = (calls, name) => ({
  ...recorder(calls, name),
  on: () => Object.freeze(recorder(calls, `${name}@connection`)),
});

test("sessions and routines send no loadable image path for a shared agent", async () => {
  const calls = [];
  const adapter = Object.freeze({
    id: "openclaw",
    sessions: port(calls, "sessions"),
    routines: port(calls, "routines"),
    config: { untouched: true },
  });
  const shared = sharedAgentAdapter(adapter);
  assert.equal(sharedAgentAdapter(adapter), shared, "one per adapter");
  assert.equal(shared.config, adapter.config);
  const text = "see ./x.png";
  const clean = "see ⁠./x.png";
  await shared.sessions.send({ key: "k", turn: { message: text, attachments: [] } });
  await shared.sessions.on("c").send({ key: "k", turn: { message: text } });
  await shared.routines.add({ routine: { name: "n", prompt: { text, model: "m" } } });
  await shared.routines.on("c").update({ id: "j", patch: { prompt: { text } } });
  await shared.routines.update({ id: "j", patch: { enabled: false } });
  assert.equal(await shared.sessions.history(), "kept");
  assert.deepEqual(calls, [
    ["sessions", "send", { key: "k", turn: { message: clean, attachments: [] } }],
    ["sessions@connection", "send", { key: "k", turn: { message: clean } }],
    ["routines", "add", { routine: { name: "n", prompt: { text: clean, model: "m" } } }],
    ["routines@connection", "update", { id: "j", patch: { prompt: { text: clean } } }],
    ["routines", "update", { id: "j", patch: { enabled: false } }],
  ]);
});
