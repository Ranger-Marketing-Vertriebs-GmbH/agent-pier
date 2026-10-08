import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { TOKEN, KEY, authorized } from "../helpers/adapter-fixture.js";
import { startAdapterServer as start, until } from "../helpers/adapter-process.js";

const claudeBody = () => loadFixture("clients/claude-code/text.json").body;
const codexBody = () => loadFixture("clients/codex/text.json").body;
const chatEvents = () =>
  loadFixture("upstreams/chat/text.sse")
    .split(/\n\n/)
    .filter((block) => block.trim())
    .map((block) => `${block}\n\n`);

const head = (res) => res.writeHead(200, { "content-type": "text/event-stream" });
const post = (url, body) =>
  fetch(url, { method: "POST", headers: authorized(), body: JSON.stringify(body) });
const lastEvent = (text) => [...text.matchAll(/^event: (\S+)$/gm)].at(-1)?.[1];

/** Streams a request with `http.request`; `onData` sees the accumulated body. */
function streamRaw(url, body, onData = () => {}) {
  const target = new URL(url);
  const state = { text: "", req: null, done: null };
  state.done = new Promise((resolve) => {
    state.req = http.request(
      target,
      { method: "POST", headers: authorized(), agent: false },
      (res) => {
        state.response = res;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          state.text += chunk;
          onData(state);
        });
        res.on("end", () => resolve("end"));
        res.on("error", () => resolve("error"));
        res.on("close", () => resolve("close"));
      },
    );
    state.req.on("error", () => resolve("error"));
    state.req.end(JSON.stringify(body));
  });
  return state;
}

test("Messages keep-alive pings start only after the first frame", async (t) => {
  const events = chatEvents();
  const up = await scriptedUpstream(t, async (_e, res) => {
    head(res);
    res.write(events[0] + events[1]); // role chunk + first text
    await delay(250);
    res.end(events.slice(2).join(""));
  });
  const { url } = await start(t, up, {}, { keepaliveMs: 50 });
  const res = await post(`${url}/v1/messages`, claudeBody());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  const begin = text.indexOf("event: message_start");
  const ping = text.indexOf("event: ping");
  assert.ok(begin >= 0 && ping > begin, "ping after message_start");
  assert.equal(lastEvent(text), "message_stop");
});

test("Responses keep-alives run before the upstream answers", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => {
    await delay(250);
    sse(res, loadFixture("upstreams/chat/text.sse"));
  });
  const { url } = await start(
    t,
    up,
    { clientProtocol: "responses" },
    { keepaliveMs: 50 },
  );
  const res = await post(`${url}/v1/responses`, codexBody());
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.startsWith("event: response.in_progress"));
  assert.equal(lastEvent(text), "response.completed");
  const beforeCreated = text.slice(0, text.indexOf("event: response.created"));
  assert.ok(beforeCreated.split("event: response.in_progress").length - 1 >= 2);
  const sequence = [...text.matchAll(/"sequence_number":(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(sequence.length > 2);
  for (let i = 1; i < sequence.length; i += 1) assert.ok(sequence[i] > sequence[i - 1]);
});

test("the idle timeout mid-stream ends a Messages stream with an error event", async (t) => {
  const events = chatEvents();
  const up = await scriptedUpstream(t, (_e, res) => {
    head(res);
    res.write(events[0] + events[1]);
  });
  const { url, server } = await start(t, up, {}, { idleTimeoutMs: 100 });
  const text = await (await post(`${url}/v1/messages`, claudeBody())).text();
  assert.equal(lastEvent(text), "error");
  assert.equal(server.snapshot().errors["stream.timeout"], 1);
  await until(() => up.seen[0].closed, 1000);
});

test("the idle timeout before upstream headers fails a Responses stream in-band", async (t) => {
  const up = await scriptedUpstream(t, () => {});
  const { url, server } = await start(
    t,
    up,
    { clientProtocol: "responses" },
    { idleTimeoutMs: 100 },
  );
  const res = await post(`${url}/v1/responses`, codexBody());
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: response\.created/);
  assert.equal(lastEvent(text), "response.failed");
  assert.equal(server.snapshot().errors["transport.timeout"], 1);
});

test("a client disconnect closes the upstream request and is not a timeout", async (t) => {
  const events = chatEvents();
  const up = await scriptedUpstream(t, (_e, res) => {
    head(res);
    res.write(events[0] + events[1]);
  });
  const { url, server } = await start(t, up);
  const stream = streamRaw(`${url}/v1/messages`, claudeBody(), (state) => {
    if (state.text.includes("\n\n")) state.req.destroy();
  });
  await stream.done;
  await until(() => up.seen[0]?.closed, 1000);
  await until(() => server.snapshot().clientDisconnects === 1, 1000);
  const { errors } = server.snapshot();
  assert.equal(errors["stream.timeout"], undefined);
  assert.equal(errors["transport.timeout"], undefined);
  // A user leaving is not an upstream failure.
  assert.equal(errors["stream.network"], undefined);
  assert.equal(errors["transport.network"], undefined);
});

test("concurrent requests get their own exchange and survive a sibling's disconnect", async (t) => {
  const events = chatEvents();
  const up = await scriptedUpstream(t, async (_e, res, index) => {
    head(res);
    res.write(events[0] + events[1]);
    if (index === 0) return;
    await delay(200);
    res.end(events.slice(2).join(""));
  });
  const { url, server } = await start(t, up);
  const first = streamRaw(`${url}/v1/messages`, claudeBody(), (state) => {
    if (state.text.includes("\n\n")) state.req.destroy();
  });
  await until(() => up.seen.length === 1);
  const second = streamRaw(`${url}/v1/messages`, claudeBody());
  await first.done;
  assert.equal(await second.done, "end");
  assert.equal(lastEvent(second.text), "message_stop");
  const id = (text) => /"id":"(msg_[0-9a-f]{32})"/.exec(text)?.[1];
  assert.ok(id(first.text) && id(second.text));
  assert.notEqual(id(first.text), id(second.text));
  assert.equal(server.snapshot().clientDisconnects, 1);
});

test("close() ends open streams and upstream requests promptly", async (t) => {
  const events = chatEvents();
  const up = await scriptedUpstream(t, (_e, res) => {
    head(res);
    res.write(events[0] + events[1]);
  });
  const { url, server } = await start(t, up);
  const res = await post(`${url}/v1/messages`, claudeBody());
  const reader = res.body.getReader();
  await reader.read();
  const began = Date.now();
  await server.close();
  assert.ok(Date.now() - began < 1000);
  const rest = (async () => {
    for (;;) if ((await reader.read()).done) return "end";
  })().catch(() => "rejected");
  assert.ok(["end", "rejected"].includes(await rest));
  await until(() => up.seen[0].closed, 1000);
  const snapshot = server.snapshot();
  assert.equal(snapshot.shutdownAborts, 1);
  assert.equal(snapshot.clientDisconnects, 0);
  assert.equal(snapshot.errors["stream.network"], undefined);
});

test("the diagnostics snapshot holds counters only", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url, server } = await start(t, up, { clientProtocol: "responses" });
  const body = loadFixture("clients/codex/mcp.json").body;
  assert.ok(body.tools.some((tool) => tool.type === "web_search"));
  const prompt = "diagnostics canary prompt text";
  body.input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: prompt }],
  });
  await (await post(`${url}/v1/responses`, body)).text();
  const snapshot = server.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.route, { client: "responses", upstream: "chat" });
  assert.equal(snapshot.restarts, 0);
  assert.equal(snapshot.requests["/v1/responses"], 1);
  assert.ok(Object.values(snapshot.dropped).reduce((a, b) => a + b, 0) > 0);
  assert.deepEqual(snapshot.upstreamStatus, { "2xx": 1 });
  assert.equal(typeof snapshot.capabilities, "object");
  assert.equal(snapshot.compactionDropped, 0);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [prompt, KEY, TOKEN])
    assert.equal(serialized.includes(secret), false);
});

const contentChunk = (text) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    model: "qwen3",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;

/** Writes `chunk` until the adapter closes the request, honoring backpressure. */
async function flood(entry, res, chunk) {
  while (!entry.closed && !res.destroyed) {
    if (!res.write(chunk))
      await new Promise((resolve) => {
        res.once("drain", resolve);
        res.once("close", resolve);
      });
  }
}

test("Messages clients get nothing before the upstream headers, and errors stay HTTP", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res, index) => {
    await delay(250);
    if (index === 0) sse(res, loadFixture("upstreams/chat/text.sse"));
    else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    }
  });
  const { url } = await start(t, up, {}, { keepaliveMs: 50 });
  const ok = await post(`${url}/v1/messages`, claudeBody());
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.ok(text.startsWith("event: message_start"));
  const failed = await post(`${url}/v1/messages`, claudeBody());
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).type, "error");
});

test("no keep-alive follows a terminal frame", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => {
    head(res);
    res.write(loadFixture("upstreams/chat/text.sse"));
    await delay(300); // the upstream keeps the connection open after [DONE]
    res.end();
  });
  const messages = await start(t, up, {}, { keepaliveMs: 50 });
  const a = await (await post(`${messages.url}/v1/messages`, claudeBody())).text();
  assert.equal(lastEvent(a), "message_stop");
  const responses = await start(
    t,
    up,
    { clientProtocol: "responses" },
    { keepaliveMs: 50 },
  );
  const b = await (await post(`${responses.url}/v1/responses`, codexBody())).text();
  assert.equal(lastEvent(b), "response.completed");
});

test("upstream bytes without a client frame do not hold Claude Code past the idle limit", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    head(res);
    while (!entry.closed) {
      res.write(": PROCESSING\n\n");
      await delay(40);
    }
  });
  const { url, server } = await start(t, up, {}, { idleTimeoutMs: 200 });
  const res = await post(`${url}/v1/messages`, claudeBody());
  assert.equal(res.status, 200);
  assert.equal(lastEvent(await res.text()), "error");
  assert.equal(server.snapshot().errors["stream.timeout"], 1);
  await until(() => up.seen[0].closed, 1000);
});

test("a client that stops reading is cut off after the idle limit", async (t) => {
  const chunk = contentChunk("~".repeat(64 * 1024));
  const up = await scriptedUpstream(t, async (entry, res) => {
    head(res);
    await flood(entry, res, chunk);
  });
  const { url, server } = await start(t, up, {}, { idleTimeoutMs: 300 });
  const target = new URL(`${url}/v1/messages`);
  const req = http.request(target, {
    method: "POST",
    headers: authorized(),
    agent: false,
  });
  req.on("response", (res) => res.pause()); // never reads
  req.on("error", () => {});
  req.end(JSON.stringify(claudeBody()));
  t.after(() => req.destroy());
  await until(() => server.snapshot().errors["client.stalled"] === 1, 5000);
  await until(() => up.seen[0].closed, 1000);
  const snapshot = server.snapshot();
  assert.equal(snapshot.clientDisconnects, 0);
  assert.equal(snapshot.errors["stream.network"], undefined);
});

test("a slow reader gets the complete stream without listener growth", async (t) => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.name);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const count = 300;
  const size = 16 * 1024;
  const events = chatEvents();
  const up = await scriptedUpstream(t, async (_e, res) => {
    head(res);
    res.write(events[0]);
    for (let i = 0; i < count; i += 1)
      if (!res.write(contentChunk("~".repeat(size))))
        await new Promise((resolve) => res.once("drain", resolve));
    res.end(events.slice(-2).join(""));
  });
  const { url } = await start(t, up);
  const stream = streamRaw(`${url}/v1/messages`, claudeBody(), (state) => {
    if (state.paused) return;
    state.paused = true;
    state.response.pause();
    setTimeout(() => state.response.resume(), 300);
  });
  assert.equal(await stream.done, "end");
  assert.equal(lastEvent(stream.text), "message_stop");
  assert.equal(stream.text.match(/~/g).length, count * size);
  assert.deepEqual(warnings, []);
});

test("a dropped Codex compaction item is surfaced as compactionDropped", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url, server } = await start(t, up, { clientProtocol: "responses" });
  const body = codexBody();
  body.input.unshift({ type: "compaction", encrypted_content: "x" });
  await (await post(`${url}/v1/responses`, body)).text();
  assert.equal(server.snapshot().dropped["input.compaction"], 1);
  assert.equal(server.snapshot().compactionDropped, 1);
});

test("the diagnostics file holds counters only and gets a final flush on close", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.adapter.json");
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/usage-cached.sse")),
  );
  const { url, server } = await start(t, up, { diagnosticsPath: file });
  const prompt = "diagnostics file canary prompt";
  const body = claudeBody();
  body.messages.push({ role: "user", content: prompt });
  const answer = "Cached hello.";
  assert.match(await (await post(`${url}/v1/messages`, body)).text(), /Cached hello\./);
  await until(() => fs.existsSync(file));
  // Within the 5 s interval: only the final flush on close records this one.
  await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
  await server.close();
  const raw = fs.readFileSync(file, "utf8");
  const written = JSON.parse(raw);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(written.requests["/v1/messages"], 1);
  assert.equal(written.unauthorized, 1);
  assert.equal(written.cacheReadTokens, 3072);
  assert.deepEqual(fs.readdirSync(dir), ["session.adapter.json"]);
  for (const secret of [prompt, KEY, TOKEN, answer])
    assert.equal(raw.includes(secret), false);
});
