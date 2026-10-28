import test from "node:test";
import assert from "node:assert/strict";
import { htmlLimits, htmlQuote, htmlText } from "../../server/features/mail/mail-html.js";
import { htmlBounds, tooComplexText } from "../../server/features/mail/mail-text.js";

const hangUrl = new URL("../fixtures/mail-extract-hang.mjs", import.meta.url);
const endsUrl = new URL("../fixtures/mail-extract-ends.mjs", import.meta.url);
const placeholder = { text: tooComplexText, truncated: false, tooComplex: true };

test("mail HTML is read and quoted in the child process", async () => {
  assert.deepEqual(await htmlText("<p>Hello <b>there</b></p><p>Bye</p>", 100), {
    text: "Hello there\n\nBye",
    truncated: false,
  });
  assert.deepEqual(await htmlText("<p>abcdef</p>", 3), { text: "abc", truncated: true });
  assert.equal(
    await htmlQuote(
      '<html><head><style>p{}</style></head><body><p style="x">Hi</p></body></html>',
    ),
    "<p>Hi</p>",
  );
  // Beyond the bounds the child answers so too.
  assert.deepEqual(
    await htmlText("<div>".repeat(htmlBounds.depth + 1), 100),
    placeholder,
  );
  assert.equal(await htmlQuote("<div>".repeat(htmlBounds.depth + 1)), null);
});

test("too many tags are refused without starting a child", async () => {
  const many = "<br>".repeat(htmlBounds.tags + 1);
  const started = performance.now();
  assert.deepEqual(await htmlText(many, 100, { scriptUrl: hangUrl }), placeholder);
  assert.equal(await htmlQuote(many, { scriptUrl: hangUrl }), null);
  assert.ok(performance.now() - started < 200);
});

test("a child that runs out of time or dies gives the fallback", async () => {
  const limits = { ...htmlLimits, timeoutMs: 200 };
  assert.deepEqual(
    await htmlText("<p>x</p>", 100, { limits, scriptUrl: hangUrl }),
    placeholder,
  );
  assert.equal(await htmlQuote("<p>x</p>", { limits, scriptUrl: hangUrl }), null);
  for (const how of ["signal:SIGKILL", "exit:1", 'reply:{"failed":true}'])
    assert.deepEqual(
      await htmlText(`%PDF-${how}`, 100, { scriptUrl: endsUrl }),
      placeholder,
      how,
    );
  assert.equal(await htmlQuote("%PDF-signal:SIGTERM", { scriptUrl: endsUrl }), null);
});

test("the HTML deadline is five seconds", () => {
  assert.equal(htmlLimits.timeoutMs, 5_000);
});
