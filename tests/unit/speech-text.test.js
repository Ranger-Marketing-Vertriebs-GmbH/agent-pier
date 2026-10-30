import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { maxSpokenChars, spokenText } from "../../server/features/speech/speech-text.js";

test("code blocks, tables and long inline code are not read", () => {
  const reply = [
    "# Plan",
    "",
    "Here is **the fix** for `npm test`:",
    "",
    "```js",
    "const secret = process.env.TOKEN;",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "Then `const veryLongInlineCodeThatGoesOnAndOn = somethingElse(withArgs)` runs.",
  ].join("\n");
  assert.equal(
    spokenText(reply, { language: "en" }),
    "Plan\nHere is the fix for npm test:\n(see screen)\nThen (see screen) runs.",
  );
  assert.match(spokenText("```\nx\n```", { language: "de" }), /^\(siehe Bildschirm\)$/);
  // An unclosed block at the end (a cut reply) is still not read.
  assert.equal(spokenText("Look:\n```sh\nrm -rf build"), "Look:\n(see screen)");
});

test("links say their text and long web addresses become see screen", () => {
  assert.equal(
    spokenText("Read [the guide](https://example.com/a/very/long/path) now."),
    "Read the guide now.",
  );
  assert.equal(
    spokenText("Open https://github.com/owner/repository/pull/123456 or example.com."),
    "Open (see screen) or example.com.",
  );
  assert.equal(spokenText("Go to https://agentpier.dev/."), "Go to agentpier.dev.");
  assert.equal(spokenText("![chart](https://x.y/c.png) Done"), "Done");
});

test("markdown marks, lists, quotes and HTML are dropped", () => {
  assert.equal(
    spokenText(
      "> Note\n- *one*\n- [x] two\n1. three\n\n---\n<b>bold</b> ~~old~~ __new__",
    ),
    "Note\none\ntwo\n1. three\nbold old new",
  );
});

test("a long reply is cut after a sentence and says the rest is on screen", () => {
  const text = spokenText("This is one sentence. ".repeat(400), { language: "de" });
  assert.ok(text.length <= maxSpokenChars + 30);
  assert.match(text, /sentence\. … \(siehe Bildschirm\)$/);
});

test("anything in, bounded plain text out", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 6000 }), (input) => {
      const text = spokenText(input);
      assert.equal(typeof text, "string");
      assert.ok(text.length <= maxSpokenChars + 30);
      assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f]/);
    }),
  );
  assert.equal(spokenText(null), "");
});
