// A stand-in for the live channel (GET /api/live) in browser specs, so pages that
// follow live topics keep seeing each spec's own REST mocks (docs/testing.md#live-socket-stub).
// Modes:
//   "rest"   answers every `sub` from the topic's REST route, read through the page
//            so the spec's page.route mocks answer, and re-reads it at the topic's
//            interval, sending a frame only when the JSON changed;
//   "manual" sends nothing until the test calls push().
// A signal topic is answered `same` in both modes, as the server does; the page reads
// its own route, and the test sends `changed` with changed().
// The frames follow server/features/live/live-connection.js.
import { randomUUID } from "node:crypto";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { listRows } from "../../server/features/live/live-rows.js";
import { readTopicValue, topicInfo } from "../../web/lib/live/live-topics.js";

/** The header of the stub's own REST reads; request recorders skip them. */
export const liveStubHeader = "x-agentpier-live-stub";

/** True for a REST read the stub made (a Playwright Request), not the app. */
export const isLiveStubRequest = (request) => request.headers()[liveStubHeader] === "1";

const waitMs = 10000;

// The stub of each page, for helpers that get only the page (liveStubOf).
const stubs = new WeakMap();

/** The live stub of `page` (null without one, as with `live: "real"`). */
export const liveStubOf = (page) => stubs.get(page) ?? null;

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// One REST read in the page; null when the page went away, or for a sampled topic
// while the tab is hidden (the server samples those only while someone watches;
// `state` and `inbox` keep coming to a hidden tab).
async function readThroughPage(page, path, sampled) {
  try {
    return await page.evaluate(
      async ({ path, header, sampled }) => {
        if (sampled && document.hidden) return null;
        const response = await fetch(`/api${path}`, {
          headers: { [header]: "1" },
          cache: "no-store",
        });
        return { ok: response.ok, text: response.ok ? await response.text() : "" };
      },
      { path, header: liveStubHeader, sampled },
    );
  } catch {
    // Navigation, a closed page or a failed fetch: try again at the next interval.
    return null;
  }
}

/**
 * Routes `**\/api/live` of `page` to a stub and returns its controls:
 * subscriptions(), received(), connections(), waitForSubscribe(topicId),
 * push(topicId, value), pushRest(topicId), reread(topicId), changed(topicId), stale(topicId),
 * revoke(topicId), refuse(),
 * close(code), dispose(). `received()` lists the frames the page sent, in order;
 * `connections()` counts the sockets it opened, refused ones included.
 */
export async function stubLive(page, { mode = "rest" } = {}) {
  const instance = randomUUID();
  // Row baselines, as the server keeps them: a subscription's later frames are deltas.
  const sync = new ChatSync({});
  const sockets = new Set();
  const latest = new Map();
  const waiters = new Set();
  const received = [];
  let opened = 0;
  let revision = 0;
  let refusing = false;
  let disposed = false;

  const subscribed = () => [
    ...new Set([...sockets].flatMap((socket) => [...socket.topics.keys()])),
  ];
  const notify = () => {
    for (const waiter of [...waiters])
      if (subscribed().includes(waiter.topic)) waiter.done();
  };
  const holders = (topic) => [...sockets].filter((socket) => socket.topics.has(topic));
  const send = (socket, frame) => {
    if (!socket.closed) socket.route.send(JSON.stringify(frame));
  };

  // A snapshot first, then `state` (state topics) or a rows `delta` onto the
  // subscription's last frame.
  const dataFrame = (socket, topic, value) => {
    const entry = socket.topics.get(topic);
    if (topicInfo(topic)?.mode === "rows") {
      const data = sync.encodeScoped([topic], listRows(value), entry.cursor);
      entry.cursor = data.sync.cursor || undefined;
      entry.sent = true;
      const type = data.sync.mode === "delta" ? "delta" : "snapshot";
      return send(socket, { type, topic, revision: ++revision, data });
    }
    const type = entry.sent ? "state" : "snapshot";
    entry.sent = true;
    send(socket, { type, topic, revision: ++revision, data: value });
  };

  const stopTopic = (socket, topic) => {
    const entry = socket.topics.get(topic);
    if (!entry) return;
    entry.stopped = true;
    clearTimeout(entry.timer);
    socket.topics.delete(topic);
  };

  // The topic's REST value as {ok, text}: its route plus each section's own route.
  const readTopic = async (info) => {
    const answers = new Map();
    const value = await readTopicValue(
      info.path(info.param),
      info.sections,
      async (path) => {
        const answer = await readThroughPage(page, path, info.sampled);
        answers.set(path, answer);
        return answer?.ok ? JSON.parse(answer.text) : undefined;
      },
      info.param,
    ).catch(() => undefined);
    if (!info.sections) return answers.values().next().value ?? null;
    const all = [...answers.values()];
    if (all.some((answer) => !answer)) return null;
    if (all.some((answer) => !answer.ok)) return { ok: false, text: "" };
    return { ok: true, text: JSON.stringify(value) };
  };

  const follow = (socket, topic, entry, info) => {
    let last = null;
    let first = true;
    const read = async () => {
      if (entry.stopped || disposed) return;
      clearTimeout(entry.timer);
      const answer = await readTopic(info);
      if (entry.stopped || disposed) return;
      if (answer && !answer.ok && first) send(socket, { type: "error", topic });
      if (answer?.ok && answer.text !== last) {
        last = answer.text;
        let value;
        try {
          value = JSON.parse(answer.text);
        } catch {
          value = undefined;
        }
        if (value !== undefined) dataFrame(socket, topic, value);
      }
      if (answer) first = false;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(read, info.interval);
    };
    // A server-side change: read now instead of at the next interval.
    entry.reread = read;
    read();
  };

  const subscribe = (socket, topic) => {
    stopTopic(socket, topic);
    const info = topicInfo(topic);
    if (!info) return send(socket, { type: "error", topic, code: "unknown-topic" });
    const entry = { sent: false, stopped: false, timer: null };
    socket.topics.set(topic, entry);
    notify();
    if (info.mode === "signal") send(socket, { type: "same", topic, revision });
    else if (mode === "rest") follow(socket, topic, entry, info);
    else if (latest.has(topic)) dataFrame(socket, topic, latest.get(topic));
  };

  const receive = (socket, message) => {
    let frame;
    try {
      frame = JSON.parse(String(message));
    } catch {
      frame = null;
    }
    if (plain(frame)) received.push(frame);
    const valid = plain(frame) && typeof frame.topic === "string";
    if (plain(frame) && frame.op === "ping") return send(socket, { type: "pong" });
    if (frame?.op === "sub" && valid && (frame.have === undefined || plain(frame.have)))
      return subscribe(socket, frame.topic);
    if (frame?.op === "unsub" && valid) return stopTopic(socket, frame.topic);
    // The server closes on anything else, so a client bug shows up in the spec.
    closeSocket(socket, 1008);
  };

  const closeSocket = (socket, code) => {
    for (const topic of [...socket.topics.keys()]) stopTopic(socket, topic);
    sockets.delete(socket);
    if (socket.closed) return;
    socket.closed = true;
    socket.route.close(code ? { code } : undefined).catch(() => {});
  };

  await page.routeWebSocket("**/api/live", (route) => {
    const socket = { route, topics: new Map(), closed: false };
    opened += 1;
    if (refusing || disposed) {
      socket.closed = true;
      route.close().catch(() => {});
      return;
    }
    sockets.add(socket);
    route.onMessage((message) => receive(socket, message));
    route.onClose(() => {
      socket.closed = true;
      closeSocket(socket);
    });
    send(socket, { type: "hello", instance });
  });

  const each = (topic, frame) => {
    for (const socket of holders(topic)) send(socket, { topic, revision, ...frame });
  };

  const stub = {
    subscriptions: subscribed,
    received: () => [...received],
    connections: () => opened,
    waitForSubscribe(topic) {
      return new Promise((resolve, reject) => {
        const waiter = {
          topic,
          done: () => {
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            resolve();
          },
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(`live stub: no subscription to ${topic} within ${waitMs} ms`),
            );
          }, waitMs),
        };
        waiters.add(waiter);
        notify();
      });
    },
    push(topic, value) {
      latest.set(topic, value);
      for (const socket of holders(topic)) dataFrame(socket, topic, value);
    },
    // "manual" mode: pushes what the topic's REST routes answer now (the spec's mocks).
    async pushRest(topic) {
      const info = topicInfo(topic);
      const answer = info?.path && (await readTopic(info));
      if (!answer?.ok) throw new Error(`live stub: no REST value for ${topic}`);
      stub.push(topic, JSON.parse(answer.text));
    },
    changed: (topic) => each(topic, { type: "changed", revision: ++revision }),
    // "rest" mode: reads the topic's routes now and pushes what changed, as the
    // server does after a change event.
    async reread(topic) {
      await Promise.all(
        holders(topic).map((socket) => socket.topics.get(topic)?.reread?.()),
      );
    },
    stale: (topic) => each(topic, { type: "stale" }),
    revoke(topic) {
      for (const socket of holders(topic)) {
        send(socket, { type: "revoked", topic });
        stopTopic(socket, topic);
      }
    },
    refuse() {
      refusing = true;
      for (const socket of [...sockets]) closeSocket(socket);
    },
    close(code = 1012) {
      for (const socket of [...sockets]) closeSocket(socket, code);
    },
    dispose() {
      disposed = true;
      for (const socket of [...sockets]) {
        for (const topic of [...socket.topics.keys()]) stopTopic(socket, topic);
        sockets.delete(socket);
      }
      for (const waiter of [...waiters]) clearTimeout(waiter.timer);
      waiters.clear();
    },
  };
  // A closed page reads nothing more, also in contexts the spec closes itself.
  page.once("close", () => stub.dispose());
  stubs.set(page, stub);
  return stub;
}

/**
 * Stubs the live socket of every page of `context`, the open ones and every later
 * one (context.newPage(), popups). For contexts a spec makes with
 * browser.newContext(); tests/helpers/browser-test.js does the same for the default
 * context. Returns { stubFor(page): Promise<LiveStub | null>, dispose() }.
 */
export async function stubContext(context, { mode = "rest" } = {}) {
  const stubs = new Map();
  const add = (page) => {
    // The route is requested before the spec's next call on the page reaches it.
    const stub = stubLive(page, { mode });
    stubs.set(page, stub);
    return stub;
  };
  const listener = (page) => {
    add(page).catch(() => {});
  };
  await Promise.all(context.pages().map(add));
  context.on("page", listener);
  return {
    stubFor: async (page) => (await stubs.get(page)?.catch(() => null)) ?? null,
    async dispose() {
      context.off("page", listener);
      for (const stub of await Promise.all(
        [...stubs.values()].map((stub) => stub.catch(() => null)),
      ))
        stub?.dispose();
    },
  };
}
