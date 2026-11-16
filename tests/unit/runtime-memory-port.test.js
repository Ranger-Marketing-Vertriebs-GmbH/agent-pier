import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryFor,
  runtimeFor,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { memoryContract } from "../helpers/runtime-port-memory-contract.js";

// The memory format of each runtime (agentFiles.memory) without a host: what
// memoryFor(agent) answers for callers that have no supervisor.
const hermes = { runtime: "hermes" };
memoryContract("OpenClaw's memory format", () => ({ memory: memoryFor(null) }));
memoryContract("Hermes's memory format", () => ({ memory: memoryFor(hermes) }));

test("memoryFor picks the format by the runtime the agent records", () => {
  const markdown = memoryFor({ runtime: "openclaw" });
  assert.equal(memoryFor(null), markdown);
  assert.equal(memoryFor({}), markdown);
  assert.equal(memoryFor({ runtime: "" }), markdown);
  assert.notEqual(memoryFor(hermes), markdown);
  // A runtime this AgentPier lacks keeps its memory as the default runtime does.
  assert.equal(memoryFor({ runtime: "newer" }), markdown);
});

test("the adapter's agentFiles.memory is the format memoryFor answers", () => {
  const supervisor = { client: null };
  const files = runtimeFor(null, supervisor).agentFiles;
  assert.equal(files.memory, memoryFor(null));
  assert.equal(files.on(null).memory, memoryFor(null));
});

test("OpenClaw keeps Markdown list items without a limit or a pin marker", () => {
  const memory = memoryFor(null);
  assert.equal(memory.appended("", "A"), "- A\n");
  assert.equal(memory.appended("# T\n- A\n", "B"), "# T\n- A\n- B\n");
  assert.equal(memory.appended("- A", "B"), "- A\n- B");
  assert.equal(memory.limit("MEMORY.md"), null);
  assert.equal(memory.limit("USER.md"), null);
  assert.equal(memory.pinMarker, null);
  assert.equal(memory.chars("- Zäh 📌"), 7);
});

test("Hermes keeps separated blocks with its limits and the pin marker", () => {
  const memory = memoryFor(hermes);
  assert.equal(memory.appended("", "A"), "A");
  assert.equal(memory.appended("A", "B"), "A\n§\nB");
  assert.equal(memory.appended(" \n", "B"), "B");
  assert.equal(memory.limit("MEMORY.md"), 10000);
  assert.equal(memory.limit("USER.md"), 5000);
  assert.equal(memory.limit("memory/note.md"), null);
  assert.equal(memory.pinMarker, "📌 ");
  // Hermes counts its trimmed entries joined by the separator, in code points.
  assert.equal(memory.chars("  A \n§\n\n§\n📌 B"), 7);
});
