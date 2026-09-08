import test from "node:test";
import assert from "node:assert/strict";
import { releaseManifest } from "../../server/features/operations/release-archive.js";
import { download } from "../../server/features/operations/releases.js";
for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
  test(`release manifest validates exact platform ${platform}`, () => {
    const manifest = {
      version: "1.2.3",
      platform,
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    };
    assert.equal(releaseManifest(manifest, platform), manifest);
    for (const other of [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ])
      if (other !== platform)
        assert.throws(() => releaseManifest(manifest, other), /platform/);
    assert.throws(
      () => releaseManifest({ ...manifest, version: "../../outside" }, platform),
      /version/,
    );
    assert.throws(
      () => releaseManifest({ ...manifest, schemaMax: 0 }, platform),
      /schema/,
    );
  });
test("release downloads permit bounded HTTPS asset redirects and reject downgrade or oversized output", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://assets.example.invalid/release" },
        })
      : new Response("payload");
  };
  assert.equal(
    (await download("https://channel.example.invalid/release", fetchImpl, 32)).toString(),
    "payload",
  );
  assert.equal(calls.length, 2);
  let downgrades = 0;
  await assert.rejects(
    download(
      "https://channel.example.invalid/release",
      async () => {
        downgrades++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://unsafe.invalid/file" },
        });
      },
      32,
    ),
    /HTTPS/,
  );
  assert.equal(downgrades, 1);
  await assert.rejects(
    download(
      "https://channel.example.invalid/release",
      async () => new Response("too large"),
      2,
    ),
    /limit/,
  );
});
