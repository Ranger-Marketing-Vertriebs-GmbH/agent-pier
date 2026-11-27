import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  downloadPinned,
  embeddingPaths,
  embeddingPlatformProblem,
  ensureEmbeddingModel,
  ensureEmbeddingServer,
  installedEmbeddingModel,
  installedEmbeddingServer,
  removeEmbeddingModel,
  verifyEmbeddingModel,
} from "../../server/features/assistants/runtimes/openclaw/embedding-assets.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";

// The pinned llama.cpp server and embedding model (embedding-assets.js) against a
// stand-in for the download hosts; nothing here reaches the network.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("GGUF".padEnd(4096, "embedding-model-bytes"));
const tmp = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-assets-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
// A file host: honours a range request unless told otherwise, and records them.
function host(content, { ranges = true, redirect = null, status = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, { headers = {}, signal } = {}) => {
    requests.push({ url, range: headers.range ?? null });
    if (redirect && url === redirect.from)
      return new Response(null, { status: 302, headers: { location: redirect.to } });
    if (status) return new Response("no", { status });
    const from = headers.range ? Number(/bytes=(\d+)-/.exec(headers.range)[1]) : 0;
    if (from && ranges) {
      if (from >= content.length)
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${content.length}` },
        });
      return new Response(content.subarray(from), {
        status: 206,
        headers: {
          "content-range": `bytes ${from}-${content.length - 1}/${content.length}`,
        },
      });
    }
    signal?.throwIfAborted();
    return new Response(content, { status: 200 });
  };
  return { fetchImpl, requests };
}
const pin = (content = bytes) => ({ size: content.length, sha256: sha256(content) });

test("a download lands only with the pinned size and digest", async (t) => {
  const file = path.join(tmp(t), "model.gguf");
  const { fetchImpl, requests } = host(bytes);
  const progress = [];
  await downloadPinned({
    url: "https://files.example/model.gguf",
    file,
    ...pin(),
    fetchImpl,
    onProgress: (step) => progress.push(step),
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(`${file}.partial`), false);
  assert.deepEqual(requests, [{ url: "https://files.example/model.gguf", range: null }]);
  assert.deepEqual(progress.at(0), { received: 0, total: bytes.length });
  assert.deepEqual(progress.at(-1), { received: bytes.length, total: bytes.length });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a broken-off download continues where it stopped", async (t) => {
  const file = path.join(tmp(t), "model.gguf");
  fs.writeFileSync(`${file}.partial`, bytes.subarray(0, 1000));
  const { fetchImpl, requests } = host(bytes);
  const progress = [];
  await downloadPinned({
    url: "https://files.example/m",
    file,
    ...pin(),
    fetchImpl,
    onProgress: (step) => progress.push(step.received),
  });
  assert.deepEqual(requests, [{ url: "https://files.example/m", range: "bytes=1000-" }]);
  assert.equal(progress[0], 1000);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("a host that ignores the range sends the whole file, which replaces the part", async (t) => {
  const file = path.join(tmp(t), "model.gguf");
  fs.writeFileSync(`${file}.partial`, Buffer.from("stale bytes of another file"));
  const { fetchImpl } = host(bytes, { ranges: false });
  await downloadPinned({ url: "https://files.example/m", file, ...pin(), fetchImpl });
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("a partial file that is already complete is checked without another byte", async (t) => {
  const file = path.join(tmp(t), "model.gguf");
  fs.writeFileSync(`${file}.partial`, bytes);
  const { fetchImpl, requests } = host(bytes);
  await downloadPinned({ url: "https://files.example/m", file, ...pin(), fetchImpl });
  assert.equal(requests[0].range, `bytes=${bytes.length}-`);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("other bytes than the pinned ones are discarded, never resumed", async (t) => {
  const directory = tmp(t);
  const file = path.join(directory, "model.gguf");
  const other = Buffer.from(bytes);
  other[100] ^= 1;
  for (const content of [other, Buffer.concat([bytes, bytes])]) {
    await assert.rejects(
      downloadPinned({
        url: "https://files.example/m",
        file,
        ...pin(),
        fetchImpl: host(content).fetchImpl,
      }),
      { code: "EMBEDDING_CHECKSUM_MISMATCH" },
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  // A shorter file: the first transfer counts as ended early and keeps its part;
  // the next finds nothing left to fetch, so these bytes are not the pinned file.
  const short = host(bytes.subarray(0, 100));
  const again = () =>
    downloadPinned({
      url: "https://files.example/m",
      file,
      ...pin(),
      fetchImpl: short.fetchImpl,
    });
  await assert.rejects(again(), { code: "EMBEDDING_DOWNLOAD_FAILED" });
  assert.deepEqual(fs.readdirSync(directory), ["model.gguf.partial"]);
  await assert.rejects(again(), { code: "EMBEDDING_CHECKSUM_MISMATCH" });
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.deepEqual(
    short.requests.map((request) => request.range),
    [null, "bytes=100-"],
  );
  // A resumed part that belongs to another file fails the digest as well.
  fs.writeFileSync(`${file}.partial`, other.subarray(0, 2000));
  await assert.rejects(
    downloadPinned({
      url: "https://files.example/m",
      file,
      ...pin(),
      fetchImpl: host(bytes).fetchImpl,
    }),
    { code: "EMBEDDING_CHECKSUM_MISMATCH" },
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("redirects are followed to HTTPS only; a refusal keeps the part for later", async (t) => {
  const directory = tmp(t);
  const file = path.join(directory, "model.gguf");
  const from = "https://hub.example/resolve/model.gguf";
  const moved = host(bytes, { redirect: { from, to: "https://cdn.example/blob" } });
  await downloadPinned({ url: from, file, ...pin(), fetchImpl: moved.fetchImpl });
  assert.deepEqual(
    moved.requests.map((request) => request.url),
    [from, "https://cdn.example/blob"],
  );
  fs.rmSync(file);
  for (const fetchImpl of [
    host(bytes, { redirect: { from, to: "http://cdn.example/blob" } }).fetchImpl,
    host(bytes, { status: 503 }).fetchImpl,
    async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    },
  ]) {
    fs.writeFileSync(`${file}.partial`, bytes.subarray(0, 10));
    await assert.rejects(downloadPinned({ url: from, file, ...pin(), fetchImpl }), {
      code: "EMBEDDING_DOWNLOAD_FAILED",
    });
    assert.deepEqual(fs.readdirSync(directory), ["model.gguf.partial"]);
  }
  await assert.rejects(
    downloadPinned({
      url: "http://hub.example/m",
      file,
      ...pin(),
      fetchImpl: moved.fetchImpl,
    }),
    { code: "EMBEDDING_DOWNLOAD_FAILED" },
  );
});

test("a transfer without bytes is given up, and a stop is honoured", async (t) => {
  const file = path.join(tmp(t), "model.gguf");
  const never = (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  await assert.rejects(
    downloadPinned({
      url: "https://h.example/m",
      file,
      ...pin(),
      fetchImpl: never,
      timeoutMs: 20,
    }),
    { code: "EMBEDDING_DOWNLOAD_STALLED" },
  );
  const controller = new AbortController();
  const pending = downloadPinned({
    url: "https://h.example/m",
    file,
    ...pin(),
    fetchImpl: never,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "EMBEDDING_DOWNLOAD_CANCELLED" });
});

const manifest = (model = bytes, archive = Buffer.from("archive")) => ({
  embeddingServer: {
    release: "b10809",
    commit: "5266f24da75dc449bd56cbed7addb9c8e4a6a73e",
    baseUrl: "https://builds.example/b10809/",
    archives: { "linux-x64": { name: "llama.tar.gz", ...pin(archive) } },
  },
  embeddingModel: {
    file: "model.gguf",
    url: "https://hub.example/model.gguf",
    ...pin(model),
  },
});

test("the model is installed once, with a receipt, and verified by its bytes", async (t) => {
  const root = tmp(t);
  const pins = manifest();
  const paths = embeddingPaths(root, pins, { platform: "linux", arch: "x64" });
  assert.equal(paths.model, path.join(root, "embeddings", "models", "model.gguf"));
  assert.equal(installedEmbeddingModel(root, pins), null);
  const { fetchImpl, requests } = host(bytes);
  assert.deepEqual(await ensureEmbeddingModel({ root, manifest: pins, fetchImpl }), {
    path: paths.model,
  });
  assert.deepEqual(installedEmbeddingModel(root, pins), { path: paths.model });
  assert.equal(await verifyEmbeddingModel(root, pins), true);
  // Installed: no second request.
  await ensureEmbeddingModel({ root, manifest: pins, fetchImpl });
  assert.equal(requests.length, 1);
  // Changed bytes of the right size pass the cheap check, never the digest.
  const changed = Buffer.from(bytes);
  changed[7] ^= 1;
  fs.writeFileSync(paths.model, changed);
  assert.ok(installedEmbeddingModel(root, pins));
  assert.equal(await verifyEmbeddingModel(root, pins), false);
  // Another size, a missing receipt or a receipt of another model: not installed.
  fs.writeFileSync(paths.model, bytes.subarray(1));
  assert.equal(installedEmbeddingModel(root, pins), null);
  fs.writeFileSync(paths.model, bytes);
  assert.equal(installedEmbeddingModel(root, manifest(Buffer.from("GGUF other"))), null);
  fs.rmSync(`${paths.model}.json`);
  assert.equal(installedEmbeddingModel(root, pins), null);
  // A file without its receipt is fetched again rather than trusted.
  await ensureEmbeddingModel({ root, manifest: pins, fetchImpl });
  assert.equal(requests.length, 2);
  // Removing keeps a partial download when asked to.
  fs.writeFileSync(`${paths.model}.partial`, "part");
  await removeEmbeddingModel(root, pins, { partial: false });
  assert.deepEqual(fs.readdirSync(paths.models), ["model.gguf.partial"]);
  await removeEmbeddingModel(root, pins);
  assert.deepEqual(fs.readdirSync(paths.models), []);
});

test("the server is installed from the pinned archive and must report the pinned build", async (t) => {
  const root = tmp(t);
  const archive = Buffer.from("archive");
  const pins = manifest(bytes, archive);
  const target = { platform: "linux", arch: "x64" };
  const paths = embeddingPaths(root, pins, target);
  const commands = [];
  const execute = (version) => async (command, args) => {
    commands.push([path.basename(command), args[0]]);
    if (command === "tar") {
      // Stands in for unpacking: the archive holds the server executable.
      fs.writeFileSync(path.join(args[args.indexOf("-C") + 1], "llama-server"), "#!");
      return { stdout: "" };
    }
    return { stdout: version, stderr: "" };
  };
  const good = "version: 0.4.0-dev (build 10809, commit 5266f24da)\nbuilt with gcc";
  assert.equal(embeddingPlatformProblem(pins, target), null);
  assert.equal(
    embeddingPlatformProblem(pins, { platform: "freebsd", arch: "x64" }),
    "EMBEDDING_PLATFORM_UNSUPPORTED",
  );
  await assert.rejects(
    ensureEmbeddingServer({ root, manifest: pins, platform: "freebsd", arch: "x64" }),
    { code: "EMBEDDING_PLATFORM_UNSUPPORTED" },
  );
  // Other bytes than the pinned archive, from either kind of downloader.
  await assert.rejects(
    ensureEmbeddingServer({
      root,
      manifest: pins,
      ...target,
      download: async () => Buffer.from("tampered"),
      execute: execute(good),
    }),
    { code: "EMBEDDING_CHECKSUM_MISMATCH" },
  );
  // Another build, or one that does not start on this host (a missing library).
  for (const run of [
    execute("version: 0.4.0-dev (build 10808, commit 5266f24da)"),
    execute("version: 0.4.0-dev (build 10809, commit deadbeef0)"),
    async (command, args) => {
      if (command === "tar") return execute(good)(command, args);
      throw new Error("error while loading shared libraries: libgomp.so.1");
    },
  ])
    await assert.rejects(
      ensureEmbeddingServer({
        root,
        manifest: pins,
        ...target,
        fetchImpl: host(archive).fetchImpl,
        execute: run,
      }),
      { code: "EMBEDDING_SERVER_UNUSABLE" },
    );
  assert.equal(installedEmbeddingServer(root, pins, target), null);
  // Nothing of a failed attempt is left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(paths.serverDirectory)), []);
  commands.length = 0;
  const { fetchImpl, requests } = host(archive);
  assert.deepEqual(
    await ensureEmbeddingServer({
      root,
      manifest: pins,
      ...target,
      fetchImpl,
      execute: execute(good),
    }),
    { command: paths.command },
  );
  assert.equal(requests[0].url, "https://builds.example/b10809/llama.tar.gz");
  assert.deepEqual(commands, [
    ["tar", "-xzf"],
    ["llama-server", "--version"],
  ]);
  assert.equal(paths.command, path.join(paths.serverDirectory, "llama-server"));
  assert.match(paths.serverDirectory, /embeddings[\\/]llama\.cpp[\\/]b10809-linux-x64$/);
  assert.deepEqual(installedEmbeddingServer(root, pins, target), {
    command: paths.command,
  });
  // Installed: neither a download nor a command. The runtime installer's buffer
  // downloader installs the same way.
  await ensureEmbeddingServer({
    root,
    manifest: pins,
    ...target,
    fetchImpl: () => assert.fail("no download"),
    execute: () => assert.fail("no command"),
  });
  const other = tmp(t);
  await ensureEmbeddingServer({
    root: other,
    manifest: pins,
    ...target,
    download: async (url) => {
      assert.equal(url, "https://builds.example/b10809/llama.tar.gz");
      return archive;
    },
    execute: execute(good),
  });
  assert.ok(installedEmbeddingServer(other, pins, target));
  // A receipt of another archive (a later pin) is no installation.
  assert.equal(
    installedEmbeddingServer(other, manifest(bytes, Buffer.from("next")), target),
    null,
  );
});

test("the manifest pins what the plugin of the pinned runtime expects", () => {
  const { embeddingPlugin, embeddingServer, embeddingModel, version } = runtimeManifest;
  // The plugin is OpenClaw's own, at the runtime's version.
  assert.equal(embeddingPlugin.id, "llama-cpp");
  assert.equal(embeddingPlugin.package, "@openclaw/llama-cpp-provider");
  assert.equal(embeddingPlugin.version, version);
  // One archive per platform the runtime installs on, from the llama.cpp release.
  assert.deepEqual(
    Object.keys(embeddingServer.archives).sort(),
    Object.keys(runtimeManifest.nodeChecksums).sort(),
  );
  assert.equal(
    embeddingServer.baseUrl,
    `https://github.com/ggml-org/llama.cpp/releases/download/${embeddingServer.release}/`,
  );
  for (const archive of Object.values(embeddingServer.archives)) {
    assert.match(
      archive.name,
      new RegExp(`^llama-${embeddingServer.release}-bin-.+\\.tar\\.gz$`),
    );
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(archive.size) && archive.size > 0);
  }
  assert.match(embeddingServer.commit, /^[a-f0-9]{40}$/);
  // The model at a fixed repository revision, under the cache name the plugin
  // recognises as its default model.
  assert.match(
    embeddingModel.url,
    /^https:\/\/huggingface\.co\/ggml-org\/embeddinggemma-300m-qat-q8_0-GGUF\/resolve\/[a-f0-9]{40}\/embeddinggemma-300m-qat-Q8_0\.gguf\?download=true$/,
  );
  assert.equal(embeddingModel.file, "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf");
  assert.match(embeddingModel.sha256, /^[a-f0-9]{64}$/);
  assert.equal(embeddingModel.size, 328577056);
  assert.equal(embeddingModel.termsUrl, "https://ai.google.dev/gemma/terms");
});
