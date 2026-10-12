import http from "node:http";

const listen = async (server) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
};
const closer = (server) => () =>
  new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });
const now = () => Math.floor(Date.now() / 1000);

/**
 * A loopback Telegram Bot API for the bots in `bots` (token → { id, username }):
 * long-polled updates per token, recorded calls and voice files. Never reaches
 * Telegram; OpenClaw talks to it through `channels.telegram.apiRoot`.
 */
export async function fakeBotApi(bots) {
  const calls = [];
  const queues = new Map(Object.keys(bots).map((token) => [token, []]));
  const waiters = new Map();
  const files = new Map();
  // Tokens Telegram revoked (401 everywhere) and tokens another poller holds (409).
  const rejected = new Set();
  const conflicted = new Set();
  let sequence = 1000;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const url = new URL(req.url, "http://fake");
    const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) {
      calls.push({ token: file[1], method: "file", params: { path: file[2] } });
      const data = files.get(file[2]);
      if (!data || !bots[file[1]]) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "audio/ogg" });
      return res.end(data);
    }
    const match = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!match) return res.writeHead(404).end();
    const [, token, method] = match;
    let params = {};
    try {
      if ((req.headers["content-type"] || "").includes("json"))
        params = JSON.parse(body || "{}");
      else params = Object.fromEntries(new URLSearchParams(body));
    } catch {
      params = {};
    }
    for (const [key, value] of url.searchParams) params[key] = value;
    calls.push({ token, method, params });
    const reply = (result) => {
      if (res.writableEnded) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };
    const bot = bots[token];
    if (conflicted.has(token) && method === "getUpdates") {
      res.writeHead(409, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ok: false,
          error_code: 409,
          description: "Conflict: terminated by other getUpdates request",
        }),
      );
    }
    if (!bot || rejected.has(token)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
      );
    }
    const chat = (id) => ({ id: Number(id), type: "private" });
    switch (method) {
      case "getMe":
        return reply({
          id: bot.id,
          is_bot: true,
          first_name: bot.username,
          username: bot.username,
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case "getWebhookInfo":
        return reply({ url: "", has_custom_certificate: false, pending_update_count: 0 });
      case "getUpdates": {
        const queue = queues.get(token);
        const offset = Number(params.offset || 0);
        while (queue.length && queue[0].update_id < offset) queue.shift();
        if (queue.length) return reply(queue.splice(0));
        const timer = setTimeout(
          () => {
            waiters.delete(token);
            reply([]);
          },
          Math.min(Number(params.timeout || 0), 2) * 1000,
        );
        waiters.set(token, () => {
          clearTimeout(timer);
          waiters.delete(token);
          reply(queue.splice(0));
        });
        return;
      }
      case "getFile": {
        const path = `voice/${params.file_id}.oga`;
        return reply({
          file_id: params.file_id,
          file_unique_id: `u${params.file_id}`,
          file_size: files.get(path)?.length,
          file_path: path,
        });
      }
      case "sendMessage":
      case "editMessageText":
        return reply({
          message_id: Number(params.message_id) || ++sequence,
          date: now(),
          chat: chat(params.chat_id),
          text: params.text,
        });
      case "getMyCommands":
        return reply([]);
      default:
        return reply(true);
    }
  });
  const url = await listen(server);
  const push = (token, message) => {
    queues.get(token).push({
      update_id: ++sequence,
      message: { message_id: ++sequence, date: now(), ...message },
    });
    waiters.get(token)?.();
  };
  const from = (person) => ({
    chat: { id: Number(person.id), type: "private", first_name: person.name },
    from: { id: Number(person.id), is_bot: false, first_name: person.name },
  });
  return {
    url,
    calls,
    /** A private text message from `person` ({ id, name }) to the bot of `token`. */
    text: (token, person, text) => push(token, { ...from(person), text }),
    /** A private voice note whose file the fake serves. */
    voice(token, person, fileId, data) {
      files.set(`voice/${fileId}.oga`, data);
      push(token, {
        ...from(person),
        voice: {
          file_id: fileId,
          file_unique_id: `u${fileId}`,
          duration: 2,
          mime_type: "audio/ogg",
          file_size: data.length,
        },
      });
    },
    /** A message from `person` in a supergroup the bot belongs to. */
    group: (token, person, chatId, text) =>
      push(token, {
        chat: { id: chatId, type: "supergroup", title: "Fixture group" },
        from: { id: Number(person.id), is_bot: false, first_name: person.name },
        text,
      }),
    reject: (token) => rejected.add(token),
    conflict: (token) => conflicted.add(token),
    sent: (token, chatId) =>
      calls.filter(
        (c) =>
          c.token === token &&
          c.method === "sendMessage" &&
          String(c.params.chat_id) === String(chatId),
      ),
    polls: (token) =>
      calls.filter((c) => c.token === token && c.method === "getUpdates").length,
    close: closer(server),
  };
}

/** A loopback Deepgram `/listen` endpoint answering every upload with `transcript`. */
export async function fakeDeepgram(transcript) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let size = 0;
    for await (const part of req) size += part.length;
    requests.push({ url: req.url, authorization: req.headers.authorization, size });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }),
    );
  });
  const url = await listen(server);
  return { url: `${url}/v1`, requests, close: closer(server) };
}
