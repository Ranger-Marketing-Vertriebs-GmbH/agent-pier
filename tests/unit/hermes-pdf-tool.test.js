import test from "node:test";
import assert from "node:assert/strict";
import {
  chatFallback,
  invoice,
  listen,
  python,
  readPdf,
} from "../helpers/hermes-pdf-tool.js";

// AgentPier's pdf tool of a Hermes agent (hermes-config/pdf-tool.py) in Python, with
// a stand-in for pypdfium2 (tests/helpers/hermes-pdf-tool.js).
const skip = { skip: !python && "python3 is not installed" };
const answer = (content) => () => ({
  body: JSON.stringify({ choices: [{ message: { content } }] }),
});

test(
  "an agent whose model sees images gets the text and the scanned page",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "own" },
      args: { pdf: "docs/scan.pdf", prompt: "What is the total?", password: "secret" },
    });
    assert.equal(result._multimodal, true);
    const [text, image] = result.content;
    assert.match(text.text, /^Request: What is the total\?/);
    assert.match(text.text, /--- Page 1 ---\nInvoice 4711/);
    assert.match(text.text, /--- Page 2 ---\n\[This page has little or no text/);
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(result.content.length, 2, "only the page without text as an image");
    assert.match(result.text_summary, /could not be shown here/);
    // The bridge judged the call for its chat, and learned only which files.
    assert.equal(seen[0].url, "/hermes-guard");
    assert.equal(seen[0].body.toolName, "pdf");
    assert.equal(seen[0].body.sessionKey, "agent:ap-a1:hermes:20261108_100000_abcd");
    assert.deepEqual(seen[0].body.args, { pdf: "docs/scan.pdf" });
  },
);

test(
  "a text-only agent's PDF goes to the owner's fallback model alone",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "fallback", fallback: "fb-1" },
      fallback: chatFallback,
      args: { pdfs: ["docs/scan.pdf"], prompt: "Total?" },
      model: answer("The total is 99 EUR."),
    });
    assert.deepEqual(result, { text: "The total is 99 EUR.", model: "m1" });
    const call = seen.find((entry) => entry.url === "/v1/chat/completions");
    assert.equal(call.headers.authorization, "Bearer fallback-key");
    assert.equal(call.body.model, "m1");
    const [text, image] = call.body.messages[0].content;
    assert.match(text.text, /^Total\?\n\nPDF docs\/scan\.pdf: 2 pages/);
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(seen.length, 2, "the bridge, then the fallback; nothing else");
  },
);

test(
  "after the owner switched the fallback, the old one gets nothing",
  skip,
  async (t) => {
    // The home still names fb-1 (its apply is pending or failed); the owner chose fb-2.
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "fallback", fallback: "fb-2" },
      fallback: chatFallback,
      args: { pdf: "docs/scan.pdf" },
      model: answer("never"),
    });
    assert.match(result.text, /Invoice 4711/);
    assert.match(result.note, /docs\/scan\.pdf page 2/);
    assert.deepEqual(
      seen.map((entry) => entry.url),
      ["/hermes-guard"],
    );
  },
);

test(
  "the fallback's redirect is never followed, so its key stays put",
  skip,
  async (t) => {
    const elsewhere = [];
    const other = await listen(t, (req, res) => {
      elsewhere.push(req.headers);
      res.end("{}");
    });
    const { result } = await readPdf(t, {
      guard: { allow: true, reader: "fallback", fallback: "fb-1" },
      fallback: chatFallback,
      args: { pdf: "docs/scan.pdf" },
      model: () => ({
        status: 302,
        headers: { location: `${other}/v1/chat/completions` },
        body: "",
      }),
    });
    assert.match(result.error, /refused the request \(HTTP 302\)/);
    assert.deepEqual(elsewhere, []);
  },
);

test("a ChatGPT fallback reads through the proxy's Responses stream", skip, async (t) => {
  const events = [
    { type: "response.output_text.delta", delta: "Total: " },
    { type: "response.output_text.delta", delta: "99 EUR" },
    { type: "response.completed", response: { status: "completed" } },
  ];
  const { result, seen } = await readPdf(t, {
    guard: { allow: true, reader: "fallback", fallback: "fb-1" },
    fallback: {
      chatgpt: { profileId: "p1", modelId: "gpt-5.4", holder: "agentpier" },
      images: true,
      id: "fb-1",
    },
    args: { pdf: "docs/scan.pdf" },
    model: () => ({
      type: "text/event-stream",
      body: events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
    }),
  });
  assert.deepEqual(result, { text: "Total: 99 EUR", model: "gpt-5.4" });
  const call = seen.find((entry) => entry.url === "/chatgpt/codex/responses");
  assert.equal(call.headers.authorization, "Bearer fallback-key");
  assert.equal(call.body.stream, true);
  assert.equal(call.body.store, false);
  const parts = call.body.input[0].content;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["input_text", "input_image"],
  );
  assert.match(parts[0].text, /^Analyze this PDF document\./);
});

test(
  "without a model that sees images the agent gets the text, and is told what it missed",
  skip,
  async (t) => {
    const { result, seen } = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "docs/scan.pdf", pages: "1-2" },
    });
    assert.match(result.text, /Invoice 4711/);
    assert.match(result.note, /were not read: docs\/scan\.pdf page 2\./);
    assert.equal(seen.length, 1);
    // A refusal reaches the agent as AgentPier words it; no file is read.
    const refused = await readPdf(t, {
      guard: { allow: false, message: "This agent may not read PDFs." },
      args: { pdf: "docs/scan.pdf" },
    });
    assert.deepEqual(refused.result, { error: "This agent may not read PDFs." });
    // Paths outside its folder stay closed even if the bridge were wrong.
    const outside = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "../../etc/hosts" },
    });
    assert.match(outside.result.error, /files in your workspace/);
  },
);

test("the size, page and pixel limits hold for a whole call", skip, async (t) => {
  const own = { allow: true, reader: "own" };
  const large = await readPdf(t, {
    guard: own,
    args: { pdf: "big.pdf" },
    files: { "big.pdf": `%PDF-1.4\n${"x".repeat(2048)}` },
    settings: { maxBytes: 1024 },
  });
  assert.match(large.result.error, /larger than/);
  const other = await readPdf(t, {
    guard: own,
    args: { pdf: "notes.pdf" },
    files: { "notes.pdf": "plain text" },
  });
  assert.match(other.result.error, /is not a PDF/);
  // 25 text pages: the first 20 are read, and the agent is told so.
  const pages = Array.from({ length: 25 }, (_, i) => `${invoice} page ${i + 1}`);
  const long = await readPdf(t, {
    guard: { allow: true, reader: "text" },
    args: { pdf: "long.pdf" },
    files: { "long.pdf": `%PDF-1.4\n${pages.join("\f")}` },
  });
  assert.match(long.result.text, /Partial document: only pages 1, 2, .*, 20 were read/);
  assert.match(long.result.text, /--- Page 20 ---/);
  assert.doesNotMatch(long.result.text, /--- Page 21 ---/);
  const selected = await readPdf(t, {
    guard: { allow: true, reader: "text" },
    args: { pdf: "long.pdf", pages: "3,5-6" },
    files: { "long.pdf": `%PDF-1.4\n${pages.join("\f")}` },
  });
  assert.deepEqual(
    [...selected.result.text.matchAll(/--- Page (\d+) ---/g)].map((m) => m[1]),
    ["3", "5", "6"],
  );
  for (const spec of ["x", "3-", "0", "99"]) {
    const wrong = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "long.pdf", pages: spec },
      files: { "long.pdf": `%PDF-1.4\n${pages.join("\f")}` },
    });
    assert.ok(wrong.result.error, spec);
  }
  // Two scans in two PDFs share one call's budget of pixels.
  const scans = await readPdf(t, {
    guard: own,
    args: { pdfs: ["a.pdf", "b.pdf"] },
    files: { "a.pdf": "%PDF-1.4\n", "b.pdf": "%PDF-1.4\n" },
    settings: { pixelBudget: 1_000_000 },
  });
  const widths = scans.result.content
    .slice(1)
    .map((part) =>
      Number(Buffer.from(part.image_url.url.split(",")[1], "base64").toString().slice(5)),
    );
  const pixels = widths.reduce(
    (sum, width) => sum + width * Math.round((width * 792) / 612),
    0,
  );
  assert.equal(widths.length, 2);
  assert.ok(pixels <= 1_000_000, `${pixels} pixels`);
  // An encrypted PDF opens with its password only.
  const locked = { "locked.pdf": `%PDF-1.4\nLOCKED ${invoice}` };
  const without = await readPdf(t, {
    guard: own,
    args: { pdf: "locked.pdf" },
    files: locked,
  });
  assert.match(without.result.error, /give its password/);
  const opened = await readPdf(t, {
    guard: own,
    args: { pdf: "locked.pdf", password: "pw" },
    files: locked,
  });
  assert.match(opened.result.text, /LOCKED Invoice 4711/);
});

test(
  "a PDF that stalls or crashes PDFium ends its child, not the agent",
  skip,
  async (t) => {
    const slow = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "slow.pdf" },
      files: { "slow.pdf": "%PDF-1.4\nSLOW" },
      settings: { timeoutS: 2 },
    });
    assert.match(slow.result.error, /took too long/);
    const crash = await readPdf(t, {
      guard: { allow: true, reader: "text" },
      args: { pdf: "crash.pdf" },
      files: { "crash.pdf": "%PDF-1.4\nCRASH" },
    });
    assert.match(crash.result.error, /not available right now/);
  },
);
