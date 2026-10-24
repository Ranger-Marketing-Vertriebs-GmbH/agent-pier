import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { jpegOf } from "../helpers/image-bytes.js";
import { mp4File } from "../helpers/video-fixtures.js";
import { TelegramIngress } from "../../server/features/assistant-channels/telegram-ingress.js";
import { ALBUM_QUIET_MS } from "../../server/features/assistant-channels/channel-ledger.js";
import {
  MB,
  en,
  media,
  photo,
  run,
  setup,
  signal,
} from "../helpers/telegram-media-fixture.js";

const process = (f) => f.service.process(f.channel.id, signal());
const input = (f, n = 0) => f.service.ledger.list(f.channel.id)[n];
const getFiles = (f) => f.api.requests.filter((r) => r.endsWith("/getFile")).length;
const outage = () => Response.json({ ok: false, error_code: 502 }, { status: 502 });

test("Telegram outages are retried with backoff, and the third failure refuses only that file", async (t) => {
  const f = setup(t, { p: { path: "photos/p.jpg", body: jpegOf() } });
  f.api.fault = (kind) => (kind === "getFile" ? outage() : undefined);
  await f.service.ingress.receive(f.channel.id, [
    media(1, { ...photo("p"), caption: "Hi" }),
  ]);
  await process(f);
  assert.equal(input(f).state, "queued");
  assert.equal(input(f).media[0].tries, 1);
  // Nothing is tried again before the delay: 5 s, then 20 s.
  await process(f);
  f.advance(4999);
  await process(f);
  assert.equal(getFiles(f), 1);
  f.advance(1);
  await process(f);
  assert.equal(getFiles(f), 2);
  f.advance(19999);
  await process(f);
  assert.equal(getFiles(f), 2);
  f.advance(1);
  await process(f);
  assert.equal(getFiles(f), 3);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, "Hi");
  assert.deepEqual(f.notices(), [
    en.telegramMediaPartly(
      `${en.telegramMediaLabels.photo}: ${en.telegramMediaReasons.download}`,
    ),
  ]);
});

test("a failed file download is retried, a file Telegram refuses is not", async (t) => {
  const f = setup(t, {
    a: { path: "photos/a.jpg", body: jpegOf() },
    b: { path: "photos/b.jpg", body: jpegOf(8, 8) },
  });
  let drops = 1;
  f.api.fault = (kind, id) => {
    if (kind !== "file") return undefined;
    if (id === "a" && drops-- > 0) throw TypeError("socket hang up");
    if (id === "b") return new Response("gone", { status: 404 });
  };
  await f.service.ingress.receive(f.channel.id, [
    media(1, { ...photo("a"), media_group_id: "g" }),
    media(2, { ...photo("b"), media_group_id: "g" }),
  ]);
  await run(f);
  assert.equal(f.sent.length, 0);
  assert.equal(input(f).retryAt, f.service.now() + 5000);
  f.advance(5000);
  await process(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.files().length, 1);
  assert.equal(input(f).media[0].tries, undefined);
  assert.equal(f.api.downloads(), 3);
  assert.deepEqual(f.notices(), [
    en.telegramMediaPartly(
      `${en.telegramMediaLabels.photo}: ${en.telegramMediaReasons.download}`,
    ),
  ]);
});

test("nothing is downloaded during maintenance or while every video slot is taken", async (t) => {
  const f = setup(t, {
    p: { path: "photos/p.jpg", body: jpegOf() },
    v: { path: "videos/v.mp4", body: mp4File() },
  });
  f.assistants.maintenance = true;
  await f.service.ingress.receive(f.channel.id, [media(1, photo("p"))]);
  await process(f);
  f.advance(5000);
  await process(f);
  assert.equal(f.api.requests.length && getFiles(f), 0);
  assert.equal(input(f).media[0].tries, undefined);
  f.assistants.maintenance = false;
  f.advance(5000);
  await process(f);
  assert.equal(f.sent.length, 1);
  f.service.ledger.patch(input(f).id, { state: "delivered" });
  f.assistants.ledger.transition(input(f).attemptId, "completed");
  // The owner's browser holds all three video uploads of the agent.
  const { videos } = f.assistants.attachments;
  const open = [];
  for (let n = 0; n < 3; n++)
    open.push(
      (
        await videos.begin(
          input(f).conversationId,
          "x.mp4",
          5000,
          mp4File(),
          randomUUID(),
        )
      ).upload,
    );
  await f.service.ingress.receive(f.channel.id, [media(2, { video: { file_id: "v" } })]);
  await process(f);
  assert.equal(f.api.downloads(), 1);
  await videos.cancel(input(f).conversationId, open[0]);
  f.advance(5000);
  await process(f);
  assert.equal(f.sent.length, 2);
  assert.equal(f.files(1)[0].kind, "video");
  assert.deepEqual(f.notices(), []);
});

test("maintenance between video chunks gives the upload up and tries again later", async (t) => {
  const body = mp4File({ payload: 9 * MB });
  const f = setup(t, { v: { path: "videos/v.mp4", body } });
  const { videos } = f.assistants.attachments;
  const receive = videos.receive.bind(videos);
  let chunks = 0;
  videos.receive = async (...args) => {
    if (++chunks === 1) f.assistants.maintenance = true;
    return receive(...args);
  };
  await f.service.ingress.receive(f.channel.id, [media(1, { video: { file_id: "v" } })]);
  await process(f);
  assert.equal(chunks, 1);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.folder(), []);
  f.assistants.maintenance = false;
  f.advance(5000);
  await process(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.files()[0].size, body.length);
});

test("after a restart an album waits for the first poll to bring its remaining items", async (t) => {
  const f = setup(t, {
    a: { path: "photos/a.jpg", body: jpegOf() },
    b: { path: "photos/b.jpg", body: jpegOf(8, 8) },
  });
  await f.deliver([media(1, { ...photo("a"), media_group_id: "g", caption: "Both" })]);
  f.service.ingress = new TelegramIngress(f.service);
  f.advance(10 * ALBUM_QUIET_MS);
  await process(f);
  assert.equal(f.sent.length, 0);
  await f.deliver([media(2, { ...photo("b"), media_group_id: "g" })]);
  await run(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.files().length, 2);
  assert.equal(f.service.ledger.public(f.channel.id).length, 1);
});

test("a failed first poll after a restart keeps the album waiting, for at most 60 s", async (t) => {
  const f = setup(t, {
    a: { path: "photos/a.jpg", body: jpegOf() },
    b: { path: "photos/b.jpg", body: jpegOf(8, 8) },
  });
  await f.deliver([media(1, { ...photo("a"), media_group_id: "g", caption: "Both" })]);
  f.service.ingress = new TelegramIngress(f.service);
  f.advance(10 * ALBUM_QUIET_MS);
  let down = true;
  f.api.fault = (kind) => (kind === "getUpdates" && down ? outage() : undefined);
  await f.deliver();
  f.advance(5000);
  await process(f);
  assert.equal(f.sent.length, 0);
  down = false;
  await f.deliver([media(2, { ...photo("b"), media_group_id: "g" })]);
  await run(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.files().length, 2);
  // Polls that only ever fail hold an album for 60 s after its newest item at most.
  f.service.ledger.patch(input(f).id, { state: "delivered" });
  f.assistants.ledger.transition(input(f).attemptId, "completed");
  await f.deliver([media(3, { ...photo("a"), media_group_id: "h" })]);
  f.service.ingress = new TelegramIngress(f.service);
  down = true;
  f.advance(59000);
  await f.deliver();
  f.advance(500);
  await process(f);
  assert.equal(f.sent.length, 1);
  f.advance(500);
  await process(f);
  assert.equal(f.sent.length, 2);
});

test("an item arriving after its album was fetched is its own input with its own notice", async (t) => {
  const f = setup(t, {
    a: { path: "photos/a.jpg", body: jpegOf() },
    z: { path: "documents/z.zip", body: Buffer.from("PK zip") },
  });
  const send = f.assistants.send;
  let busy = true;
  f.assistants.send = async (...args) => {
    if (busy) {
      busy = false;
      throw Object.assign(Error("busy"), { status: 409 });
    }
    return send(...args);
  };
  await f.service.ingress.receive(f.channel.id, [
    media(1, { ...photo("a"), media_group_id: "g", caption: "Look" }),
  ]);
  await run(f);
  assert.equal(input(f).state, "queued");
  await f.deliver([
    media(2, {
      document: { file_id: "z", file_name: "archive.zip" },
      media_group_id: "g",
    }),
  ]);
  await run(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.files().length, 1);
  f.service.ledger.patch(input(f).id, { state: "delivered" });
  f.assistants.ledger.transition(input(f).attemptId, "completed");
  await run(f);
  assert.equal(input(f, 1).state, "failed");
  assert.equal(input(f, 1).diagnostic, "MEDIA_REFUSED");
  assert.deepEqual(f.notices(), [
    en.telegramMediaNothing(
      `${en.telegramMediaFile("archive.zip")}: ${en.telegramMediaReasons.type}`,
    ),
  ]);
});

test("a file that is not a video stops downloading at 10 MB", async (t) => {
  const f = setup(t, {
    big: { path: "documents/big.txt", body: Buffer.alloc(1), size: 0 },
  });
  // Telegram states no size; the bytes keep coming, 1 MB at a time.
  let served = 0;
  f.api.fault = (kind) =>
    kind === "file"
      ? new Response(
          new ReadableStream({
            pull(controller) {
              served += MB;
              if (served > 25 * MB) controller.close();
              else controller.enqueue(new Uint8Array(MB).fill(97));
            },
          }),
        )
      : undefined;
  await f.service.ingress.receive(f.channel.id, [
    media(1, { document: { file_id: "big", file_name: "notes.txt" }, caption: "Read" }),
  ]);
  await process(f);
  assert.ok(served <= 13 * MB, `read ${served / MB} MB`);
  assert.equal(f.sent[0].text, "Read");
  assert.deepEqual(f.notices(), [
    en.telegramMediaPartly(
      `${en.telegramMediaFile("notes.txt")}: ${en.telegramMediaTooLarge(10)}`,
    ),
  ]);
});

test("the staged files of an input that finally fails are removed at once", async (t) => {
  const f = setup(t, { p: { path: "photos/p.jpg", body: jpegOf() } });
  f.assistants.send = async () => {
    throw Object.assign(Error("refused"), { status: 404 });
  };
  await f.service.ingress.receive(f.channel.id, [media(1, photo("p"))]);
  await process(f);
  assert.equal(input(f).diagnostic, "MODEL_REQUEST_FAILED");
  assert.deepEqual(f.folder(), []);
  assert.deepEqual(
    f.assistants.attachments.staged(
      input(f).conversationId,
      [input(f).media[0].staged],
      false,
    ),
    [],
  );
});
