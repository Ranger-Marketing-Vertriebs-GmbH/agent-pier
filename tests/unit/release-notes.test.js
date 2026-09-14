import test from "node:test";
import assert from "node:assert/strict";
import {
  ReleaseNotes,
  officialChannel,
} from "../../server/features/operations/release-notes.js";

const metadata = {
  tag_name: "v1.17.5",
  draft: false,
  body: "## Fixes\n\n- Show every question.",
};
test("release notes use the exact tag, return only presentation data and coalesce reads", async () => {
  const calls = [];
  const notes = new ReleaseNotes(async (url, options) => {
    calls.push({ url, options });
    return Response.json({
      ...metadata,
      author: { private: "not exposed" },
      html_url: "https://unrelated.example",
    });
  });
  const [first, second] = await Promise.all([
    notes.read(officialChannel, "1.17.5"),
    notes.read(officialChannel, "1.17.5"),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    version: "1.17.5",
    body: metadata.body,
    url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v1.17.5",
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/releases/tags/v1.17.5"));
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await notes.read(officialChannel, "1.17.6");
  assert.equal(calls.length, 2);
});
for (const [name, fetchImpl] of [
  ["rate limit", async () => new Response("rate limited", { status: 403 })],
  ["missing release", async () => new Response("missing", { status: 404 })],
  [
    "timeout",
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ],
  ["wrong tag", async () => Response.json({ ...metadata, tag_name: "v1.17.6" })],
  ["draft", async () => Response.json({ ...metadata, draft: true })],
  ["missing body", async () => Response.json({ ...metadata, body: null })],
  ["empty body", async () => Response.json({ ...metadata, body: "  " })],
  ["invalid JSON", async () => new Response("invalid")],
  [
    "oversized header",
    async () => new Response("small", { headers: { "Content-Length": "999999" } }),
  ],
  ["oversized stream", async () => new Response("x".repeat(300000))],
])
  test(`release notes tolerate ${name} without affecting updates`, async () => {
    const result = await new ReleaseNotes(fetchImpl).read(officialChannel, "1.17.5");
    assert.equal(result.body, null);
    assert.ok(result.url.endsWith("/v1.17.5"));
  });
test("custom channels never receive unrelated official release notes or trigger requests", async () => {
  const notes = new ReleaseNotes(() => {
    throw Error("Must not fetch");
  });
  assert.deepEqual(await notes.read("https://custom.example/releases/", "1.17.5"), {
    version: "1.17.5",
    body: null,
    url: null,
  });
  await assert.rejects(notes.read(officialChannel, "../../latest"));
});
