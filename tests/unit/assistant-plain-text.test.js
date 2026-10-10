import test from "node:test";
import assert from "node:assert/strict";
import { plainText } from "../../web/features/assistants/plain-text.js";

test("markdown syntax is dropped from announcements", () => {
  assert.equal(
    plainText(
      "# Title\n\n**bold** and [a link](https://x.test) ![pic](https://y.test/a.png)",
    ),
    "Title bold and a link pic",
  );
  assert.equal(plainText("| a | b |\n| - | - |\n| one | two |"), "a b one two");
  assert.equal(plainText("```js\nlet x = 1;\n```"), "let x = 1;");
});

test("nested and overlapping tags are stripped to a fixed point", () => {
  assert.equal(plainText("<<b>b>alert(1)</b>"), "b>alert(1)");
  assert.equal(plainText("a <scr<b>ipt>b"), "a ipt>b");
});
