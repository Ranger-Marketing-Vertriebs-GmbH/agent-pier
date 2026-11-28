import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  downloadPinned,
  downloadResumed,
  requireSpace,
} from "../../server/features/tools/pinned-download.js";
import { downloadPinned as embeddingDownload } from "../../server/features/assistants/runtimes/openclaw/embedding-assets.js";

// The shared resumable download (tools/pinned-download.js). Its behaviour for the
// embedding assets is guarded by embedding-assets.test.js, which runs unchanged;
// here: the code prefix, the host list, the retries and the space check.
const bytes = Buffer.from("PK".padEnd(4096, "pinned-archive-bytes"));
const pin = {
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const tmp = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-download-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const serve =
  (content = bytes) =>
  async (url, { headers = {}, signal } = {}) => {
    signal?.throwIfAborted();
    const from = headers.range ? Number(/bytes=(\d+)-/.exec(headers.range)[1]) : 0;
    return new Response(content.subarray(from), {
      status: from ? 206 : 200,
      headers: from
        ? { "content-range": `bytes ${from}-${content.length - 1}/${content.length}` }
        : {},
    });
  };

test("the embedding assets export the moved function itself", () => {
  assert.equal(embeddingDownload, downloadPinned);
});

test("the codes carry the caller's prefix", async (t) => {
  const file = path.join(tmp(t), "archive.zip");
  const devices = { url: "https://dl.example/a.zip", file, ...pin, prefix: "DEVICES" };
  await assert.rejects(
    downloadPinned({ ...devices, fetchImpl: serve(Buffer.from(bytes).fill(1, 10, 20)) }),
    { code: "DEVICES_CHECKSUM_MISMATCH" },
  );
  await assert.rejects(
    downloadPinned({
      ...devices,
      fetchImpl: async () => new Response("no", { status: 503 }),
    }),
    { code: "DEVICES_DOWNLOAD_FAILED", upstreamStatus: 503 },
  );
  await assert.rejects(
    downloadPinned({ ...devices, url: "http://dl.example/a.zip", fetchImpl: serve() }),
    { code: "DEVICES_DOWNLOAD_FAILED" },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadPinned({ ...devices, fetchImpl: serve(), signal: controller.signal }),
    { code: "DEVICES_DOWNLOAD_CANCELLED" },
  );
  // A transfer that answers and then delivers nothing is given up after `timeoutMs`.
  const silent = async (url, { signal }) =>
    new Response(
      new ReadableStream({
        start(stream) {
          signal.addEventListener("abort", () => stream.error(signal.reason));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(downloadPinned({ ...devices, fetchImpl: silent, timeoutMs: 20 }), {
    code: "DEVICES_DOWNLOAD_STALLED",
  });
  // Without a prefix the codes are the embedding ones, as before the move.
  await assert.rejects(
    downloadPinned({
      url: devices.url,
      file,
      ...pin,
      fetchImpl: async () => new Response("no", { status: 503 }),
    }),
    { code: "EMBEDDING_DOWNLOAD_FAILED" },
  );
  await downloadPinned({ ...devices, fetchImpl: serve() });
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("with a host list every hop must be on it", async (t) => {
  const directory = tmp(t);
  const file = path.join(directory, "archive.zip");
  const requests = [];
  const redirecting = (to) => async (url, options) => {
    requests.push(url);
    return url === "https://dl.google.com/a.zip"
      ? new Response(null, { status: 302, headers: { location: to } })
      : serve()(url, options);
  };
  const options = {
    url: "https://dl.google.com/a.zip",
    file,
    ...pin,
    prefix: "DEVICES",
    hosts: ["dl.google.com", "edgedl.me.gvt1.com"],
  };
  // A redirect to another host is refused before that host is asked.
  await assert.rejects(
    downloadPinned({
      ...options,
      fetchImpl: redirecting("https://mirror.example/a.zip"),
    }),
    { code: "DEVICES_DOWNLOAD_FAILED" },
  );
  assert.deepEqual(requests, ["https://dl.google.com/a.zip"]);
  assert.equal(fs.existsSync(file), false);
  // The first address is checked too.
  await assert.rejects(
    downloadPinned({
      ...options,
      url: "https://mirror.example/a.zip",
      fetchImpl: serve(),
    }),
    { code: "DEVICES_DOWNLOAD_FAILED" },
  );
  // A host that merely ends like a listed one is another host.
  await assert.rejects(
    downloadPinned({
      ...options,
      fetchImpl: redirecting("https://evil-dl.google.com.example/a.zip"),
    }),
    { code: "DEVICES_DOWNLOAD_FAILED" },
  );
  // A redirect to a listed host is followed; without a list any HTTPS host is.
  await downloadPinned({
    ...options,
    fetchImpl: redirecting("https://edgedl.me.gvt1.com/a.zip"),
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  const other = path.join(directory, "other.zip");
  await downloadPinned({
    ...options,
    hosts: null,
    file: other,
    fetchImpl: redirecting("https://mirror.example/a.zip"),
  });
  assert.deepEqual(fs.readFileSync(other), bytes);
});

test("a transfer that breaks off is continued by the next attempt", async (t) => {
  const file = path.join(tmp(t), "archive.zip");
  const ranges = [];
  // Each answer delivers 1500 bytes of what was asked for, then the connection ends.
  const breaking = async (url, { headers = {} } = {}) => {
    ranges.push(headers.range ?? null);
    const from = headers.range ? Number(/bytes=(\d+)-/.exec(headers.range)[1]) : 0;
    return new Response(bytes.subarray(from, from + 1500), {
      status: from ? 206 : 200,
      headers: from
        ? { "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` }
        : {},
    });
  };
  const options = { url: "https://dl.example/a.zip", file, ...pin, prefix: "DEVICES" };
  await downloadResumed({ ...options, fetchImpl: breaking });
  assert.deepEqual(ranges, [null, "bytes=1500-", "bytes=3000-"]);
  assert.deepEqual(fs.readFileSync(file), bytes);

  // Two attempts are not enough for it; the part stays for a later call.
  fs.rmSync(file);
  ranges.length = 0;
  await assert.rejects(downloadResumed({ ...options, fetchImpl: breaking }, 2), {
    code: "DEVICES_DOWNLOAD_FAILED",
  });
  assert.equal(fs.statSync(`${file}.partial`).size, 3000);
  // Bytes that are not the pinned file are not tried again.
  let asked = 0;
  await assert.rejects(
    downloadResumed({
      ...options,
      file: `${file}.other`,
      fetchImpl: async () => (
        asked++,
        new Response(Buffer.alloc(bytes.length), { status: 200 })
      ),
    }),
    { code: "DEVICES_CHECKSUM_MISMATCH" },
  );
  assert.equal(asked, 1);
});

test("too little free space is refused with the caller's code", async (t) => {
  const directory = tmp(t);
  t.mock.method(fsp, "statfs", async () => ({ bavail: 10n, bsize: 4096n }));
  await assert.rejects(requireSpace(directory, 40961, "DEVICES_DISK_SPACE"), {
    code: "DEVICES_DISK_SPACE",
  });
  await requireSpace(directory, 40960, "DEVICES_DISK_SPACE");
  // A file system that does not report its space is not refused.
  fsp.statfs.mock.mockImplementation(async () => {
    throw Error("unsupported");
  });
  await requireSpace(directory, Number.MAX_SAFE_INTEGER, "DEVICES_DISK_SPACE");
});
