import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
