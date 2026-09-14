import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

/** Synthetic files stay inside the disposable native probe project. */
export async function probeNativeImages({
  send,
  capture,
  provider,
  waitFor,
  counts,
  directory,
}) {
  const png = syntheticPng();
  const files = [];
  for (let n = 0; n < 7; n++) {
    const file = path.join(directory, `synthetic-image-${n}.png`);
    await fs.writeFile(file, png);
    files.push(file);
  }
  const marker = "AP_PROBE_IMAGES";
  const before = { ...counts };
  const start = performance.now();
  await send([marker, ...files].join("\n"));
  const submitMs = performance.now() - start;
  assert.equal(counts.paste - before.paste, 1);
  assert.equal(counts.submit - before.submit, 1);
  try {
    await waitFor(
      () => provider.events,
      (events) =>
        events.some((event) => event.kind === "request" && event.marker === marker),
    );
    await waitFor(capture, (screen) =>
      screen.includes(`Synthetic response complete: ${marker}`),
    );
    assert.ok(
      provider.events.some(
        (event) =>
          event.kind === "request" &&
          event.marker === marker &&
          event.imageCount === files.length,
      ),
    );
  } catch (error) {
    console.error(
      "IMAGE_PROBE_SCREEN",
      (await capture()).replaceAll(directory, "<probe-project>"),
    );
    throw error;
  }
  return {
    files: files.length,
    bytesPerFile: png.length,
    paste: 1,
    submit: 1,
    submitMs,
    accepted: true,
  };
}

function syntheticPng() {
  const width = 1536,
    height = 1024;
  const pixels = randomBytes((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  function chunk(type, data) {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
