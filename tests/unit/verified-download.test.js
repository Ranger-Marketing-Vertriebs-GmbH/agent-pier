import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  reaSources,
  verifiedDownload,
} from "../../server/features/tools/verified-download.js";

const body = Buffer.alloc(300 * 1024, 7);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const allow = {
  "ghcr.io": ["/v2/homebrew/core/ghidra/blobs/"],
  "pkg-containers.githubusercontent.com": null,
  "github.com": ["/NationalSecurityAgency/ghidra/releases/download/"],
  "objects.githubusercontent.com": null,
};
const blob = "https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc";
const entryFor = (buffer = body, extra = {}) => ({
  url: blob,
  sha256: sha(buffer),
  size: buffer.length,
  ...extra,
});

// A local HTTP server standing in for the https hosts: `routes` maps "host/path" to a
// handler; fetchImpl rewrites https://host/path to it and records every request.
async function harness(t, routes) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url.slice(1)];
    if (!handler) {
      res.writeHead(404);
      return res.end();
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const requests = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    requests.push({ url: target.href, init, headers: new Headers(init.headers) });
    const { port } = server.address();
    return fetch(`http://127.0.0.1:${port}/${target.host}${target.pathname}`, init);
  };
  return { fetchImpl, requests };
}
const send =
  (buffer, headers = {}) =>
  (req, res) => {
    res.writeHead(200, { "content-length": buffer.length, ...headers });
    res.end(buffer);
  };
const redirect =
  (location, status = 302) =>
  (req, res) => {
    res.writeHead(status, { location });
    res.end();
  };
function target(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-download-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "archive.bin");
}
const problemWith =
  (message, status = 409) =>
  (error) => {
    assert.equal(error.message, message);
    assert.equal(error.status, status);
    return true;
  };

test("the REA sources allow exactly the pinned hosts and release paths", () => {
  assert.deepEqual(reaSources, {
    "ghcr.io": ["/v2/homebrew/core/ghidra/blobs/"],
    "pkg-containers.githubusercontent.com": null,
    "github.com": [
      "/NationalSecurityAgency/ghidra/releases/download/",
      "/adoptium/temurin21-binaries/releases/download/",
      "/frida/frida/releases/download/",
    ],
    "release-assets.githubusercontent.com": null,
    "objects.githubusercontent.com": null,
  });
  assert.ok(Object.isFrozen(reaSources));
});

test("streams a matching download and reports whole percents", async (t) => {
  const { fetchImpl, requests } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": send(body),
  });
  const file = target(t);
  const percents = [];
  await verifiedDownload({
    entry: entryFor(),
    file,
    allow,
    fetchImpl,
    progress: (percent) => percents.push(percent),
  });
  assert.deepEqual(fs.readFileSync(file), body);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(percents.length > 0);
  assert.equal(percents.at(-1), 100);
  for (const [index, percent] of percents.entries()) {
    assert.ok(Number.isInteger(percent) && percent >= 0 && percent <= 100);
    if (index) assert.ok(percent > percents[index - 1]);
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, "manual");
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(requests[0].headers.get("user-agent"), "AgentPier");
});

test("follows up to three redirects, each checked against the allowlist", async (t) => {
  const { fetchImpl, requests } = await harness(t, {
    "github.com/NationalSecurityAgency/ghidra/releases/download/a.zip": redirect(
      "/NationalSecurityAgency/ghidra/releases/download/b.zip",
      301,
    ),
    "github.com/NationalSecurityAgency/ghidra/releases/download/b.zip": redirect(
      "https://objects.githubusercontent.com/x?token=secret",
      307,
    ),
    "objects.githubusercontent.com/x": redirect(
      "https://pkg-containers.githubusercontent.com/final",
      308,
    ),
    "pkg-containers.githubusercontent.com/final": send(body),
  });
  const file = target(t);
  await verifiedDownload({
    entry: entryFor(body, {
      url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/a.zip",
    }),
    file,
    allow,
    fetchImpl,
  });
  assert.deepEqual(fs.readFileSync(file), body);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/a.zip",
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/b.zip",
      "https://objects.githubusercontent.com/x?token=secret",
      "https://pkg-containers.githubusercontent.com/final",
    ],
  );
  for (const request of requests) assert.equal(request.init.redirect, "manual");
});

test("refuses a redirect to a host or path outside the allowlist", async (t) => {
  for (const location of [
    "https://example.com/v2/homebrew/core/ghidra/blobs/x",
    "https://github.com/someone/else/releases/download/x",
    "https://ghcr.io/v2/homebrew/core/other/blobs/x",
    "https://ghcr.io/v2/homebrew/core/ghidra/blobs/../../other/blobs/x",
    "https://ghcr.io./v2/homebrew/core/ghidra/blobs/x",
    "https://__proto__/x",
  ]) {
    const { fetchImpl, requests } = await harness(t, {
      "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": redirect(location),
    });
    const file = target(t);
    await assert.rejects(
      verifiedDownload({ entry: entryFor(), file, allow, fetchImpl }),
      problemWith(serverMessages.rea.forbiddenRedirect),
      location,
    );
    assert.equal(requests.length, 1, location);
    assert.equal(fs.existsSync(file), false);
  }
  const { fetchImpl, requests } = await harness(t, {});
  await assert.rejects(
    verifiedDownload({
      entry: entryFor(body, { url: "https://example.com/a.zip" }),
      file: target(t),
      allow,
      fetchImpl,
    }),
    problemWith(serverMessages.rea.downloadFailed),
  );
  assert.equal(requests.length, 0);
});

test("refuses http:, credentials, ports and a fourth redirect", async (t) => {
  for (const location of [
    "http://pkg-containers.githubusercontent.com/x",
    "https://user:pass@pkg-containers.githubusercontent.com/x",
    "https://pkg-containers.githubusercontent.com:8443/x",
    "file:///etc/passwd",
  ]) {
    const { fetchImpl, requests } = await harness(t, {
      "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": redirect(location),
    });
    await assert.rejects(
      verifiedDownload({ entry: entryFor(), file: target(t), allow, fetchImpl }),
      problemWith(serverMessages.rea.forbiddenRedirect),
      location,
    );
    assert.equal(requests.length, 1, location);
  }
  const hop = (n) => `https://pkg-containers.githubusercontent.com/${n}`;
  const { fetchImpl, requests } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": redirect(hop(1)),
    "pkg-containers.githubusercontent.com/1": redirect(hop(2)),
    "pkg-containers.githubusercontent.com/2": redirect(hop(3)),
    "pkg-containers.githubusercontent.com/3": redirect(hop(4)),
    "pkg-containers.githubusercontent.com/4": send(body),
  });
  const file = target(t);
  await assert.rejects(
    verifiedDownload({ entry: entryFor(), file, allow, fetchImpl }),
    problemWith(serverMessages.rea.redirectLimit),
  );
  assert.equal(requests.length, 4);
  assert.equal(fs.existsSync(file), false);
});

test("sends 'Authorization: Bearer QQ==' only to ghcr.io, never after a redirect", async (t) => {
  const { fetchImpl, requests } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": redirect(
      "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abc?se=1&sig=x",
      307,
    ),
    "pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abc": send(body),
  });
  await verifiedDownload({
    entry: entryFor(body, { auth: "ghcr-anonymous" }),
    file: target(t),
    allow,
    fetchImpl,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get("authorization"), "Bearer QQ==");
  assert.equal(requests[1].headers.get("authorization"), null);

  // Without the entry's auth marker no host gets the token, ghcr.io included.
  const plain = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": send(body),
  });
  await verifiedDownload({
    entry: entryFor(),
    file: target(t),
    allow,
    fetchImpl: plain.fetchImpl,
  });
  assert.equal(plain.requests[0].headers.get("authorization"), null);

  // The marker never sends the token to another host, even as the first request.
  const github = await harness(t, {
    "github.com/NationalSecurityAgency/ghidra/releases/download/a.zip": send(body),
  });
  await verifiedDownload({
    entry: entryFor(body, {
      auth: "ghcr-anonymous",
      url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/a.zip",
    }),
    file: target(t),
    allow,
    fetchImpl: github.fetchImpl,
  });
  assert.equal(github.requests[0].headers.get("authorization"), null);
});

test("refuses a wrong content-length, an oversize body and a wrong SHA-256", async (t) => {
  const tampered = Buffer.from(body);
  tampered[0] ^= 1;
  const cases = [
    // A declared length that differs from the pinned size.
    (req, res) => {
      res.writeHead(200, { "content-length": body.length + 1 });
      res.end(Buffer.concat([body, Buffer.from("x")]));
    },
    // A chunked body that grows past the pinned size.
    (req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.write(body);
      res.end(Buffer.from("more"));
    },
    // A body that ends short of the pinned size.
    (req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(body.subarray(1));
    },
    // The right size with different bytes.
    send(tampered),
  ];
  for (const [index, handler] of cases.entries()) {
    const { fetchImpl } = await harness(t, {
      "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": handler,
    });
    const file = target(t);
    await assert.rejects(
      verifiedDownload({ entry: entryFor(), file, allow, fetchImpl }),
      problemWith(serverMessages.rea.checksumMismatch),
      `case ${index}`,
    );
    assert.equal(fs.existsSync(file), false, `case ${index}`);
  }
});

test("a non-2xx answer names the status", async (t) => {
  const { fetchImpl } = await harness(t, {});
  const file = target(t);
  await assert.rejects(
    verifiedDownload({ entry: entryFor(), file, allow, fetchImpl }),
    problemWith(serverMessages.tools.downloadHttpFailed(404)),
  );
  assert.equal(fs.existsSync(file), false);

  const failing = async () => {
    throw new TypeError("fetch failed: https://ghcr.io/?token=secret");
  };
  await assert.rejects(
    verifiedDownload({ entry: entryFor(), file, allow, fetchImpl: failing }),
    problemWith(serverMessages.rea.downloadFailed),
  );
});

test("never replaces an existing file", async (t) => {
  const { fetchImpl } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": send(body),
  });
  const file = target(t);
  fs.writeFileSync(file, "keep");
  await assert.rejects(
    verifiedDownload({ entry: entryFor(), file, allow, fetchImpl }),
    problemWith(serverMessages.rea.downloadFailed),
  );
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("lets a full disk through with its own code", async (t) => {
  const { fetchImpl } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": send(body),
  });
  const file = target(t);
  await assert.rejects(
    verifiedDownload({
      entry: entryFor(),
      file,
      allow,
      fetchImpl,
      progress: () => {
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      },
    }),
    (error) => error.code === "ENOSPC",
  );
  assert.equal(fs.existsSync(file), false);
});

test("an abort stops the download and leaves no partial file behind", async (t) => {
  const { fetchImpl } = await harness(t, {
    "ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:abc": (req, res) => {
      res.writeHead(200, { "content-length": body.length });
      res.write(body.subarray(0, 1024));
      // The rest never comes; only the abort ends the download.
    },
  });
  const file = target(t);
  const controller = new AbortController();
  await assert.rejects(
    verifiedDownload({
      entry: entryFor(),
      file,
      allow,
      fetchImpl,
      signal: controller.signal,
      progress: () => controller.abort(),
    }),
    problemWith(serverMessages.tools.installationAbortedOrTimedOut),
  );
  assert.equal(fs.existsSync(file), false);

  const aborted = AbortSignal.abort();
  await assert.rejects(
    verifiedDownload({ entry: entryFor(), file, allow, fetchImpl, signal: aborted }),
    problemWith(serverMessages.tools.installationAbortedOrTimedOut),
  );
  assert.equal(fs.existsSync(file), false);
});
