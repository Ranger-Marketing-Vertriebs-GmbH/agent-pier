import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createUpstreamClient } from "../../server/features/providers/endpoint-stream.js";

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../../server/features/providers/endpoint-stream.js"),
).href;
const loopback = (_host, options, callback) =>
  options?.all
    ? callback(null, [{ address: "127.0.0.1", family: 4 }])
    : callback(null, "127.0.0.1", 4);

/** Runs one request in a child Node that trusts `caFile` the way the adapter does (R5). */
function childRequest(baseUrl, caFile) {
  const script = `
    import { createUpstreamClient } from ${JSON.stringify(moduleUrl)};
    const lookup = ${loopback.toString()};
    const client = createUpstreamClient({ baseUrl: ${JSON.stringify(baseUrl)}, lookup });
    try {
      const response = await client.request({ path: "/x", body: {}, headers: {} });
      console.log(JSON.stringify({ status: response.status, text: await response.text(64) }));
    } catch (error) {
      console.log(JSON.stringify({ kind: error.adapterKind }));
    } finally {
      client.close();
    }`;
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: caFile }, timeout: 10_000 },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
    ),
  );
}

test("https sends SNI for the hostname and verifies the certificate", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentpier-endpoint-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=model.test",
      "-addext",
      "subjectAltName=DNS:model.test",
    ],
    { stdio: "ignore" },
  );
  const names = [];
  let served = 0;
  const server = https.createServer(
    {
      key: await readFile(key),
      cert: await readFile(cert),
      SNICallback: (name, callback) => {
        names.push(name);
        callback(null, null);
      },
    },
    (_request, response) => {
      served += 1;
      response.end("{}");
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const port = server.address().port;

  const untrusted = createUpstreamClient({
    baseUrl: `https://model.test:${port}/v1`,
    lookup: loopback,
  });
  t.after(() => untrusted.close());
  await assert.rejects(untrusted.request({ path: "/x", body: {}, headers: {} }), {
    adapterKind: "network",
    message: "upstream connection failed",
  });
  assert.equal(served, 0, "an untrusted certificate is refused before any request");

  assert.deepEqual(await childRequest(`https://model.test:${port}/v1`, cert), {
    status: 200,
    text: "{}",
  });
  assert.deepEqual(await childRequest(`https://other.test:${port}/v1`, cert), {
    kind: "network",
  });
  assert.equal(served, 1, "only the matching hostname reached the server");
  assert.ok(names.includes("model.test"));
  assert.ok(names.includes("other.test"));
});
