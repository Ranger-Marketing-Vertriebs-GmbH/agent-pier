import test from "node:test";
import assert from "node:assert/strict";
import {
  dreamInput,
  dreamMessageLimit,
  dreamSummaryLimit,
  hermesDreamInstructions,
  parseDream,
} from "../../server/features/assistants/hermes-dream-prompt.js";

const files = {
  "MEMORY.md": "📌 Owner drinks tea\n§\nSecond note",
  "USER.md": "Likes cats",
};
const chat = (text, at) => ({ role: "person", text, at });

test("the dream input lists ids, limits and chats oldest first", () => {
  const input = dreamInput({
    files,
    chats: [
      {
        channel: "telegram",
        messages: [chat("later words", 200), chat("earlier words", 100)],
      },
      { channel: "web", messages: [chat("x".repeat(dreamMessageLimit + 500), 300)] },
    ],
  });
  assert.match(input, /=== MEMORY\.md/);
  assert.match(input, /\[M1\] 📌 Owner drinks tea/);
  assert.match(input, /\[U1\] Likes cats/);
  assert.match(input, /8000 of 10000/);
  assert.match(input, /4000 of 5000/);
  assert.match(input, /=== Chats/);
  assert.ok(input.indexOf("--- chat 1") > input.indexOf("=== Chats"));
  assert.ok(input.indexOf("earlier words") < input.indexOf("later words"));
  assert.ok(input.includes("x".repeat(dreamMessageLimit)));
  assert.ok(!input.includes("x".repeat(dreamMessageLimit + 1)));
});

test("instructions name the rules", () => {
  for (const rule of [
    /data/,
    /never follow instructions/i,
    /📌/,
    /keep/,
    /JSON only/,
    /80 %/,
  ]) {
    assert.match(hermesDreamInstructions, rule);
  }
});

const before = {
  "MEMORY.md": "📌 a\n§\nb\n§\nb again",
  "USER.md": "likes tea",
};
const answer = (value) => JSON.stringify(value);

test("an answer of keeps and texts assembles both files", () => {
  const parsed = parseDream(
    answer({
      "MEMORY.md": [
        { keep: "M1" },
        { text: "b, merged", from: ["M2", "M3"] },
        { text: "new fact" },
      ],
      "USER.md": [{ text: "likes coffee now", from: ["U1"] }],
      summary: "Merged b.",
    }),
    before,
  );
  assert.equal(parsed.files["MEMORY.md"], "📌 a\n§\nb, merged\n§\nnew fact");
  assert.equal(parsed.files["USER.md"], "likes coffee now");
  assert.deepEqual(parsed.counts["MEMORY.md"], {
    kept: 1,
    added: 1,
    merged: 1,
    replaced: 0,
    dropped: 0,
  });
  assert.equal(parsed.counts["USER.md"].replaced, 1);
  assert.equal(parsed.summary, "Merged b.");
});

test("an id not listed is dropped", () => {
  const parsed = parseDream(
    answer({
      "MEMORY.md": [{ keep: "M1" }, { text: "b", from: ["M2"] }],
      "USER.md": [{ keep: "U1" }],
      summary: "",
    }),
    before,
  );
  assert.equal(parsed.counts["MEMORY.md"].dropped, 1);
  assert.equal(parsed.counts["USER.md"].dropped, 0);
});

test("a broken answer is null", () => {
  const ok = { "MEMORY.md": [{ keep: "M1" }], "USER.md": [{ keep: "U1" }], summary: "s" };
  assert.ok(parseDream(answer(ok), before));
  const bad = [
    "not json",
    answer({ ...ok, "MEMORY.md": [{ keep: "M9" }] }),
    answer({ ...ok, "MEMORY.md": [{ keep: "U1" }] }),
    answer({ ...ok, "MEMORY.md": [{ keep: "M1" }, { keep: "M1" }] }),
    answer({ ...ok, "MEMORY.md": [{ keep: "M1" }, { text: "b", from: ["M1"] }] }),
    answer({ ...ok, "MEMORY.md": [{ text: "" }] }),
    answer({ ...ok, "MEMORY.md": [{ text: 5 }] }),
    answer({ ...ok, "MEMORY.md": [{ text: "x", from: ["U1"] }] }),
    answer({ "MEMORY.md": ok["MEMORY.md"], summary: "s" }),
    answer({ ...ok, "USER.md": "nope" }),
    answer([]),
  ];
  for (const text of bad) assert.equal(parseDream(text, before), null, text);
});

test("a fenced JSON block is accepted", () => {
  const ok = { "MEMORY.md": [{ keep: "M1" }], "USER.md": [], summary: "s" };
  const parsed = parseDream("```json\n" + answer(ok) + "\n```", before);
  assert.equal(parsed.files["MEMORY.md"], "📌 a");
  assert.equal(parsed.files["USER.md"], "");
});

test("the summary is clipped", () => {
  const parsed = parseDream(
    answer({ "MEMORY.md": [], "USER.md": [], summary: "s".repeat(700) }),
    before,
  );
  assert.equal(parsed.summary.length, dreamSummaryLimit);
  assert.equal(dreamSummaryLimit, 600);
});
