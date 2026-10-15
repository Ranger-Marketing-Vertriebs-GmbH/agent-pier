import test from "node:test";
import assert from "node:assert/strict";
import {
  completeMessage,
  historyText,
  withNote,
} from "../../server/features/assistants/history-text.js";
import { withRoutineResults } from "../../server/features/assistants/routine-results.js";

test("OpenClaw's cut marker and placeholders are never taken as reply text", () => {
  assert.deepEqual(historyText("Hello"), { text: "Hello", cut: false });
  assert.deepEqual(historyText("Hello\n...(truncated)..."), { text: "Hello", cut: true });
  for (const placeholder of [
    "[chat.history omitted: message too large]",
    "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]",
  ])
    assert.deepEqual(historyText(placeholder), { text: "", cut: true });
  assert.deepEqual(historyText(undefined), { text: "", cut: false });
});

test("a cut message is read on its own and the longer text wins", async () => {
  const asked = [];
  const assistants = {
    message: async (conversationId, id) => {
      asked.push([conversationId, id]);
      return "Hello world, complete.";
    },
  };
  const page = { id: "m1", text: "Hello\n...(truncated)..." };
  assert.deepEqual(await completeMessage(assistants, "c1", page), {
    text: "Hello world, complete.",
    cut: false,
  });
  assert.deepEqual(asked, [["c1", "m1"]]);
  // Complete text is not read again.
  await completeMessage(assistants, "c1", { id: "m2", text: "Done." });
  assert.equal(asked.length, 1);
  // A longer text that does not continue the page's is not the same message.
  assistants.message = async () => "Something else, and much longer.";
  assert.deepEqual(await completeMessage(assistants, "c1", page), {
    text: "Hello",
    cut: true,
  });
  // A placeholder or failure alone keeps the page's text.
  assistants.message = async () => "[chat.history omitted: message too large]";
  assert.deepEqual(await completeMessage(assistants, "c1", page), {
    text: "Hello",
    cut: true,
  });
  assistants.message = async () => {
    throw Error("gone");
  };
  assert.deepEqual(await completeMessage(assistants, "c1", page), {
    text: "Hello",
    cut: true,
  });
});

test("a partial history message is read on its own", async () => {
  const assistants = { message: async () => "Hello world" };
  assert.deepEqual(
    await completeMessage(assistants, "c1", { id: "m1", text: "Hello", partial: true }),
    { text: "Hello world", cut: false },
  );
});

test("a history message already marked cut stays incomplete", async () => {
  // The chat history serves its own cut flag instead of OpenClaw's marker.
  const assistants = { message: async () => "Hello" };
  assert.deepEqual(
    await completeMessage(assistants, "c1", { id: "m1", text: "Hello", cut: true }),
    { text: "Hello", cut: true },
  );
});

test("a note always fits, cutting the text by code point", () => {
  assert.equal(withNote("Text  ", "Note."), "Text\n\nNote.");
  assert.equal(withNote("", "Note."), "Note.");
  const text = "😀".repeat(10);
  const noted = withNote(text, "N", 10);
  assert.equal(noted, `${"😀".repeat(3)}\n\nN`);
  assert.ok(noted.length <= 10);
});

test("a committed routine result is badged even when the history page cut it", () => {
  const full = "R".repeat(9000);
  const results = [
    {
      id: "j:1",
      status: "ok",
      committed: true,
      name: "Digest",
      text: full,
      runAtMs: 1000,
      at: 1000,
    },
  ];
  const messages = [
    {
      id: "a",
      role: "assistant",
      text: `${full.slice(0, 8000)}\n...(truncated)...`,
      timestamp: 2000,
    },
    {
      id: "b",
      role: "assistant",
      text: "[chat.history omitted: message too large]",
      timestamp: 3000,
    },
    { id: "c", role: "assistant", text: `Other\n...(truncated)...`, timestamp: 4000 },
  ];
  assert.deepEqual(
    withRoutineResults(messages, results).map((m) => m.scheduled?.name ?? null),
    ["Digest", null, null],
  );
});
