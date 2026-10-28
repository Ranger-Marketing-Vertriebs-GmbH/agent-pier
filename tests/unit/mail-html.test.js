import test from "node:test";
import assert from "node:assert/strict";
import {
  htmlForward,
  htmlLimits,
  htmlQuote,
  htmlText,
} from "../../server/features/mail/mail-html.js";
import {
  extractionQueues,
  extractLimits,
  extractText,
  htmlPool,
} from "../../server/features/mail/mail-extract.js";
import { pdfWith } from "../helpers/mail-documents.js";
import {
  htmlBounds,
  htmlBusyText,
  tooComplexText,
} from "../../server/features/mail/mail-text.js";

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

test("HTML never waits behind attachment documents", async () => {
  // Every document place and the whole document queue held by slow PDFs.
  const held = Array.from(
    { length: extractLimits.concurrency + extractLimits.queue },
    () =>
      extractText(pdfWith("x"), "pdf", {
        scriptUrl: hangUrl,
        limits: { ...extractLimits, timeoutMs: 1_500 },
      }).catch((error) => error),
  );
  await assert.rejects(extractText(pdfWith("x"), "pdf"), { busy: true });
  const started = performance.now();
  assert.deepEqual(await htmlText("<p>Hello</p>", 100), {
    text: "Hello",
    truncated: false,
  });
  assert.equal(await htmlQuote("<p>Hi</p>"), "<p>Hi</p>");
  assert.ok(performance.now() - started < 1_400, "HTML did not wait for the PDFs");
  await Promise.all(held);
});

test("the HTML pool is one process with a short queue of its own", async () => {
  assert.deepEqual(htmlPool, { concurrency: 1, queue: 4 });
  // The pool decides, never the limits a child is given.
  assert.equal("concurrency" in htmlLimits || "queue" in htmlLimits, false);
  const limits = { ...htmlLimits, timeoutMs: 300 };
  const before = extractionQueues().html.started;
  const runs = Array.from({ length: 6 }, () =>
    htmlText("<p>x</p>", 100, { limits, scriptUrl: hangUrl }),
  );
  // One running, four waiting: the sixth is refused at once as busy, not too complex.
  assert.deepEqual(extractionQueues().html, {
    running: 1,
    waiting: 4,
    started: before + 1,
  });
  const results = await Promise.all(runs);
  // Five ran out of time: too complex; the sixth was busy and may be read again.
  assert.equal(results.filter((r) => r.tooComplex).length, 5);
  assert.deepEqual(results[5], { text: htmlBusyText, truncated: false, busy: true });
  assert.equal(extractionQueues().html.started - before, 5);
});

test("a quote or forward while the HTML pool is full is MAIL_BUSY", async () => {
  const limits = { ...htmlLimits, timeoutMs: 300 };
  const held = Array.from({ length: htmlPool.concurrency + htmlPool.queue }, () =>
    htmlText("<p>x</p>", 100, { limits, scriptUrl: hangUrl }),
  );
  await assert.rejects(htmlQuote("<p>x</p>"), { code: "MAIL_BUSY" });
  await assert.rejects(htmlForward("<p>x</p>", 100), { code: "MAIL_BUSY" });
  await Promise.all(held);
});

test("a forward gets quote and text from one process", async () => {
  const before = extractionQueues().html.started;
  assert.deepEqual(await htmlForward("<style>p{}</style><p>Hi <b>you</b></p>", 100), {
    quote: "<p>Hi <b>you</b></p>",
    text: { text: "Hi you", truncated: false },
  });
  assert.equal(extractionQueues().html.started - before, 1);
  assert.deepEqual(await htmlForward("<div>".repeat(htmlBounds.depth + 1), 100), {
    quote: null,
    text: placeholder,
  });
});
