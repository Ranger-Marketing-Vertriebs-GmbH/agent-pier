import fs from "node:fs";
import path from "node:path";
import { channelFixture, telegramMessage } from "./assistant-channel-fixture.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import { ALBUM_QUIET_MS } from "../../server/features/assistant-channels/channel-ledger.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

// Telegram media intake tests (assistant-telegram-media*.test.js): the real
// TelegramClient against a fake Bot API, the real attachment pipeline, a manual clock.
export const token = "123456:abcdefghijklmnopqrstuv";
export const signal = () => new AbortController().signal;
export const en = serverCatalogs.en.assistants;
export const MB = 1024 * 1024;

/**
 * A fake Bot API: getUpdates hands out `pending`, getFile answers for the files given
 * (id → { path, body, size }), the file URL serves their bytes. `fault(kind, id)` may
 * return a Response (or throw) for "getUpdates", "getFile" or "file" first, to simulate outages.
 */
function fakeTelegram(files) {
  const requests = [];
  const pending = [];
  const api = { requests, pending, fault: () => undefined };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    requests.push(pathname.replace(token, "<token>"));
    if (pathname === `/bot${token}/getUpdates`)
      return (
        api.fault("getUpdates") || Response.json({ ok: true, result: pending.splice(0) })
      );
    if (pathname === `/bot${token}/getFile`) {
      const { file_id } = JSON.parse(init.body);
      const faulty = api.fault("getFile", file_id);
      if (faulty) return faulty;
      const file = files[file_id];
      if (!file)
        return Response.json(
          { ok: false, error_code: 400, description: `Bad Request ${url}` },
          { status: 400 },
        );
      return Response.json({
        ok: true,
        result: {
          file_id,
          file_size: file.size ?? file.body.length,
          file_path: file.path,
        },
      });
    }
    const [id, file] =
      Object.entries(files).find(([, f]) => pathname === `/file/bot${token}/${f.path}`) ||
      [];
    if (file) return api.fault("file", id) || new Response(file.body);
    return Response.json({ ok: true, result: { message_id: 1, chat: { id: 42 } } });
  };
  return Object.assign(api, {
    downloads: () => requests.filter((r) => r.startsWith("/file/")).length,
    clientFactory: (secret) => new TelegramClient({ token: secret, fetchImpl }),
  });
}

export function setup(t, files, options = {}) {
  let clock = Date.parse("2026-10-24T10:00:00Z");
  const api = fakeTelegram(files);
  const f = channelFixture(t, {
    language: () => "en",
    now: () => clock,
    clientFactory: api.clientFactory,
    ...options,
  });
  return {
    ...f,
    api,
    advance: (ms) => (clock += ms),
    files: (n = 0) =>
      f.assistants.attachments.files(f.service.ledger.list(f.channel.id)[n].requestId),
    notices: () => f.service.outbox.all(f.channel.id).map((n) => n.text),
    folder: () =>
      fs.readdirSync(path.join(f.workspaces, f.channel.assistantId, "attachments")),
    // One long poll that returns these updates (none: an empty poll).
    deliver: async (updates = []) => {
      api.pending.push(...updates);
      await f.service.ingress.poll(f.channel.id, signal());
    },
  };
}

// A media message from the paired chat; `fields` are its Telegram content.
export const media = (updateId, fields) => {
  const update = telegramMessage(updateId);
  delete update.message.text;
  Object.assign(update.message, fields);
  return update;
};
export const photo = (id, size) => ({
  photo: [
    { file_id: `${id}-small`, file_size: 100 },
    { file_id: id, ...(size && { file_size: size }) },
  ],
});
// Past an album's quiet window, after a poll that brought nothing more.
export const run = async (f) => {
  f.advance(ALBUM_QUIET_MS + 1);
  await f.deliver();
  await f.service.process(f.channel.id, signal());
};
