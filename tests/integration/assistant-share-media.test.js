import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { assistantAttachmentRoutes } from "../../server/http/routes/assistant-attachments.js";
import { audioType } from "../../server/features/assistants/agent-audio-types.js";
import { run, shareFixture } from "../helpers/agent-share-fixture.js";

// An MP4 container head (ftyp isom) followed by some payload bytes.
const mp4 = () => {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  ftyp.write("isommp41", 16, "latin1");
  return Buffer.concat([ftyp, Buffer.alloc(4000, 7)]);
};
const mp3 = () =>
  Buffer.concat([
    Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.alloc(2000, 1),
  ]);

async function served(t, f) {
  const app = express();
  app.use(
    "/api",
    assistantAttachmentRoutes({
      assistants: {
        admit: (fn) => fn(),
        attachments: f.service.attachments,
        changed() {},
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return (id, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/assistant-attachments/${id}`, {
      headers,
    });
}

test("audio is recognised by its bytes", () => {
  assert.equal(audioType(mp3()), "audio/mpeg");
  assert.equal(audioType(Buffer.from("OggS\x00\x02", "latin1")), "audio/ogg");
  assert.equal(audioType(Buffer.from("fLaC\x00\x00", "latin1")), "audio/flac");
  const wav = Buffer.alloc(16);
  wav.write("RIFF", 0, "latin1");
  wav.write("WAVE", 8, "latin1");
  assert.equal(audioType(wav), "audio/wav");
  const m4a = Buffer.alloc(24);
  m4a.writeUInt32BE(24, 0);
  m4a.write("ftypM4A ", 4, "latin1");
  assert.equal(audioType(m4a), "audio/mp4");
  assert.equal(audioType(mp4()), null);
  assert.equal(audioType(Buffer.from("plain text")), null);
});

test("a shared video and audio play inline from the share route, a range at a time", async (t) => {
  const f = await shareFixture(t);
  f.file(f.agent, "clip.mp4", mp4());
  f.file(f.agent, "voice.mp3", mp3());
  await f.turn(f.chat, "media");
  const video = await run(f.tool(f.agent, f.chat), { path: "clip.mp4" });
  const audio = await run(f.tool(f.agent, f.chat), { path: "voice.mp3" });
  assert.equal(video.file.type, "video/mp4");
  assert.equal(audio.file.type, "audio/mpeg");
  const shared = (await f.service.history(f.chat.id)).messages.filter((m) => m.shared);
  assert.deepEqual(
    shared.map((m) => [m.attachments[0].kind, m.attachments[0].type]),
    [
      ["video", "video/mp4"],
      ["audio", "audio/mpeg"],
    ],
  );
  const get = await served(t, f);
  const id = shared[0].attachments[0].id;
  const whole = await get(id);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("content-disposition"), "inline");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal((await whole.arrayBuffer()).byteLength, mp4().length);
  const part = await get(id, { range: "bytes=0-23" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-23/${mp4().length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString("latin1", 4, 8), "ftyp");
  const sound = await get(shared[1].attachments[0].id, { range: "bytes=0-2" });
  assert.equal(sound.status, 206);
  assert.equal(sound.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await sound.arrayBuffer()).toString("latin1"), "ID3");
});
