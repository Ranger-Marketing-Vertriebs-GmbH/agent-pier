import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  cachedHermesDownload,
  hermesArchives,
  hermesContractDownload,
  prefetchDownload,
  prefetchHermesArchives,
  previousHermesManifest,
} from "../../scripts/hermes-contract-downloads.mjs";
import { hermesManifest } from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const folder = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-downloads-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cache");
};
// A manifest whose four archives are the given bytes.
function manifestOf(bytes) {
  const base = hermesManifest;
  return {
    ...base,
    archiveUrl: "https://example.test/source.tgz",
    archiveSha256: sha(bytes.source),
    uvChecksums: { "linux-x64": sha(bytes.uv) },
    agentBrowser: {
      ...base.agentBrowser,
      url: "https://example.test/ab.tgz",
      sha256: sha(bytes.browser),
    },
    pdfium: {
      version: "1",
      wheels: {
        "linux-x64": { url: "https://example.test/pdfium.whl", sha256: sha(bytes.wheel) },
      },
    },
  };
}
const bytes = {
  source: Buffer.from("source"),
  uv: Buffer.from("uv"),
  browser: Buffer.from("browser"),
  wheel: Buffer.from("wheel"),
};

test("both pins name their uv, source, agent-browser and PDFium archives per target", () => {
  for (const manifest of [hermesManifest, previousHermesManifest()]) {
    const archives = hermesArchives(manifest, "linux-arm64");
    assert.equal(archives.size, 4);
    assert.equal(archives.get(manifest.archiveUrl), manifest.archiveSha256);
    assert.ok([...archives.values()].includes(manifest.uvChecksums["linux-arm64"]));
  }
  assert.equal(hermesArchives(hermesManifest, "plan9-mips").size, 2);
});

test("the cache serves a pinned archive once fetched and passes other URLs through", async (t) => {
  const dir = folder(t);
  const manifest = manifestOf(bytes);
  const served = new Map([
    [manifest.archiveUrl, bytes.source],
    ["https://example.test/other", Buffer.from("other")],
  ]);
  const fetched = [];
  const download = cachedHermesDownload(dir, {
    manifests: [manifest],
    target: "linux-x64",
    download: async (url) => (fetched.push(url), served.get(url)),
  });
  assert.deepEqual(await download(manifest.archiveUrl), bytes.source);
  assert.deepEqual(await download(manifest.archiveUrl), bytes.source);
  assert.deepEqual(await download("https://example.test/other"), Buffer.from("other"));
  await download("https://example.test/other");
  assert.deepEqual(fetched, [
    manifest.archiveUrl,
    "https://example.test/other",
    "https://example.test/other",
  ]);
  assert.deepEqual(fs.readdirSync(dir), [manifest.archiveSha256]);
});

test("a mismatching download is never stored, a changed cache file is fetched again", async (t) => {
  const dir = folder(t);
  const manifest = manifestOf(bytes);
  let reply = Buffer.from("tampered");
  const download = cachedHermesDownload(dir, {
    manifests: [manifest],
    target: "linux-x64",
    download: async () => reply,
  });
  assert.deepEqual(await download(manifest.archiveUrl), Buffer.from("tampered"));
  assert.equal(fs.existsSync(dir), false);
  reply = bytes.source;
  await download(manifest.archiveUrl);
  fs.writeFileSync(path.join(dir, manifest.archiveSha256), "changed");
  reply = bytes.source;
  assert.deepEqual(await download(manifest.archiveUrl), bytes.source);
  assert.deepEqual(fs.readFileSync(path.join(dir, manifest.archiveSha256)), bytes.source);
});

test("prefetch stores every pinned archive and fails on a mismatch", async (t) => {
  const dir = folder(t);
  const manifest = manifestOf(bytes);
  const byUrl = new Map([
    [manifest.archiveUrl, bytes.source],
    [manifest.agentBrowser.url, bytes.browser],
    [manifest.pdfium.wheels["linux-x64"].url, bytes.wheel],
    [
      `https://github.com/astral-sh/uv/releases/download/${manifest.uvVersion}/uv-x86_64-unknown-linux-gnu.tar.gz`,
      bytes.uv,
    ],
  ]);
  const options = { manifests: [manifest], target: "linux-x64" };
  await prefetchHermesArchives(dir, {
    ...options,
    download: async (url) => byUrl.get(url),
  });
  assert.equal(fs.readdirSync(dir).length, 4);
  await assert.rejects(
    prefetchHermesArchives(folder(t), {
      ...options,
      download: async () => Buffer.from("x"),
    }),
    /does not match/,
  );
});

test("the contracts cache only when AGENTPIER_HERMES_DOWNLOAD_CACHE is set", () => {
  assert.equal(hermesContractDownload({}), undefined);
  assert.equal(
    typeof hermesContractDownload({ AGENTPIER_HERMES_DOWNLOAD_CACHE: "/tmp/x" }),
    "function",
  );
});

const reply = (status, retryAfter) => ({
  ok: status === 200,
  status,
  headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
  arrayBuffer: async () => new Uint8Array([1]).buffer,
});

test("the prefetch authenticates only GitHub URLs, and only with a token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => (
    calls.push([url, init.headers.authorization || "anonymous"]),
    reply(200)
  );
  const fallback = async (url) => (calls.push([url, "fallback"]), Buffer.from([2]));
  const download = prefetchDownload("t0k", { fetchImpl, fallback });
  await download("https://codeload.github.com/o/r/tar.gz/c");
  await download("https://github.com/astral-sh/uv/releases/download/1/uv.tgz");
  await download("https://registry.npmjs.org/agent-browser/-/a.tgz");
  await prefetchDownload("", { fetchImpl, fallback })("https://codeload.github.com/x");
  assert.deepEqual(calls, [
    ["https://codeload.github.com/o/r/tar.gz/c", "Bearer t0k"],
    ["https://github.com/astral-sh/uv/releases/download/1/uv.tgz", "Bearer t0k"],
    ["https://registry.npmjs.org/agent-browser/-/a.tgz", "fallback"],
    ["https://codeload.github.com/x", "anonymous"],
  ]);
});

test("the prefetch waits out GitHub's rate limit within its budget", async () => {
  const replies = [reply(429, "300"), reply(429), reply(200)];
  const slept = [];
  const download = prefetchDownload("", {
    fetchImpl: async () => replies.shift(),
    sleep: async (ms) => slept.push(ms),
    log: () => {},
  });
  assert.deepEqual(await download("https://codeload.github.com/x"), Buffer.from([1]));
  assert.deepEqual(slept, [300000, 60000]);
  const limited = prefetchDownload("", {
    fetchImpl: async () => reply(429, "600"),
    maxWaitMs: 900000,
    sleep: async () => {},
    log: () => {},
  });
  await assert.rejects(limited("https://codeload.github.com/x"), /answered 429/);
  const missing = prefetchDownload("", { fetchImpl: async () => reply(404) });
  await assert.rejects(missing("https://codeload.github.com/x"), /answered 404/);
});
