import test from "node:test";
import assert from "node:assert/strict";
import { ownProcessInputs } from "../../server/features/assistants/own-process-guidance.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";

// The guidance of an agent on its own process set names how its runtime keeps
// memory by the trait and the memory format, never by a runtime.
const agent = { id: "h1", runtime: "hermes", capabilities: { memory: true } };

test("an own-process agent's guidance carries its memory format and pin marker", async () => {
  const { guidance } = await ownProcessInputs({}, agent);
  assert.equal(guidance.memoryFormat, "entries");
  assert.equal(guidance.pinMarker, "📌 ");
  assert.equal(Object.hasOwn(guidance, "memoryKind"), false);
  const text = assistantBootstrap(agent, {}, guidance);
  assert.match(text, /Your memory is your memory tool/);
  assert.ok(text.includes("starts with `📌 `"));
});

test("the bootstrap's memory guidance follows the format it is given", () => {
  // Without one, Markdown files: the default runtime's.
  for (const options of [{}, { memoryFormat: "markdown" }]) {
    const text = assistantBootstrap(agent, {}, options);
    assert.match(text, /## Memory/);
    assert.doesNotMatch(text, /memory tool/);
    assert.ok(!text.includes("📌"));
  }
  // Separated entries without a pin marker name no pin.
  const plain = assistantBootstrap(agent, {}, { memoryFormat: "entries" });
  assert.match(plain, /Your memory is your memory tool/);
  assert.doesNotMatch(plain, /pinned entry/i);
});
