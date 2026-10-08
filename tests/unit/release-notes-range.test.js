import test from "node:test";
import assert from "node:assert/strict";
import {
  ReleaseNotes,
  officialChannel,
} from "../../server/features/operations/release-notes.js";
import {
  selectReleaseRange,
  reachesActiveVersion,
} from "../../server/features/operations/release-notes-range.js";

const release = (version, extra = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-01T10:00:00Z",
  body: `Notes for ${version}`,
  ...extra,
});
const tag = (version) =>
  `https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v${version}`;

test("range selection excludes the active version and includes the target", () => {
  const result = selectReleaseRange(
    ["1.24.2", "1.24.1", "1.24.0", "1.23.0", "1.22.0"].map((v) => release(v)),
    "1.23.0",
    "1.24.1",
  );
  assert.deepEqual(
    result.releases.map((entry) => entry.version),
    ["1.24.1", "1.24.0"],
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.releases[0], {
    version: "1.24.1",
    body: "Notes for 1.24.1",
    url: tag("1.24.1"),
    publishedAt: "2026-10-01T10:00:00.000Z",
  });
});

test("range selection skips drafts, prereleases and malformed entries", () => {
  const result = selectReleaseRange(
    [
      release("1.3.0"),
      release("1.2.1", { draft: true }),
      release("1.2.0-beta.1", { prerelease: true }),
      release("1.2.0", { prerelease: true }),
      { tag_name: "latest", draft: false },
      { tag_name: "v../../x", draft: false },
      release("1.1.0", { body: "  ", published_at: "not a date" }),
      null,
    ],
    "1.0.0",
    "1.3.0",
  );
  assert.deepEqual(
    result.releases.map((entry) => [entry.version, entry.body, entry.publishedAt]),
    [
      ["1.3.0", "Notes for 1.3.0", "2026-10-01T10:00:00.000Z"],
      ["1.1.0", null, null],
    ],
  );
});

test("range selection keeps a prerelease target the user is installing", () => {
  const result = selectReleaseRange(
    [release("2.0.0-rc.1", { prerelease: true }), release("1.9.0")],
    "1.8.0",
    "2.0.0-rc.1",
  );
  assert.deepEqual(
    result.releases.map((entry) => entry.version),
    ["2.0.0-rc.1", "1.9.0"],
  );
});

test("range selection orders by semver instead of text or publish order", () => {
  const result = selectReleaseRange(
    ["1.9.0", "1.10.0", "1.9.10", "1.9.2", "1.8.0"].map((v) => release(v)),
    "1.8.0",
    "1.10.0",
  );
  assert.deepEqual(
    result.releases.map((entry) => entry.version),
    ["1.10.0", "1.9.10", "1.9.2", "1.9.0"],
  );
});

test("range selection keeps the newest 20 versions and flags the overflow", () => {
  const entries = Array.from({ length: 25 }, (_, i) => release(`1.${i + 1}.0`));
  const result = selectReleaseRange(entries, "1.0.0", "1.25.0");
  assert.equal(result.releases.length, 20);
  assert.equal(result.releases[0].version, "1.25.0");
  assert.equal(result.releases.at(-1).version, "1.6.0");
  assert.equal(result.truncated, true);
  assert.equal(selectReleaseRange(entries.slice(5), "1.0.0", "1.25.0").truncated, false);
});

test("pagination stops once a page reaches the active version", () => {
  assert.equal(reachesActiveVersion([release("1.5.0"), release("1.4.0")], "1.4.0"), true);
  assert.equal(reachesActiveVersion([release("1.5.0")], "1.4.0"), false);
  assert.equal(reachesActiveVersion([release("1.3.0", { draft: true })], "1.4.0"), false);
});

const page = (entries, init) =>
  new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

test("range notes use the paginated list endpoint and stop at the active version", async () => {
  const calls = [];
  const pages = [
    Array.from({ length: 100 }, (_, i) => release(`2.${100 - i}.0`)),
    [release("2.0.0"), release("1.24.1"), release("1.24.0"), release("1.23.0")],
  ];
  const notes = new ReleaseNotes(async (url, options) => {
    calls.push({ url, options });
    return page(pages[calls.length - 1] ?? []);
  });
  const result = await notes.range(officialChannel, "1.23.0", "1.24.1");
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    const url = new URL(call.url);
    assert.equal(
      url.origin + url.pathname,
      "https://api.github.com/repos/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
    );
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page"), String(index + 1));
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.headers.Authorization, undefined);
  }
  assert.deepEqual(
    result.releases.map((entry) => entry.version),
    ["1.24.1", "1.24.0"],
  );
  assert.equal(result.truncated, false);
  assert.equal(
    result.url,
    "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
  );
});

test("range notes stop after a short page without reaching the active version", async () => {
  let calls = 0;
  const notes = new ReleaseNotes(async () => {
    calls++;
    return page([release("1.2.0"), release("1.1.0")]);
  });
  const result = await notes.range(officialChannel, "0.9.0", "1.2.0");
  assert.equal(calls, 1);
  assert.equal(result.releases.length, 2);
});

test("range notes bound pagination and flag possibly missing versions", async () => {
  let calls = 0;
  const notes = new ReleaseNotes(async () => {
    calls++;
    return page(Array.from({ length: 100 }, (_, i) => release(`9.${calls}.${i}`)));
  });
  const result = await notes.range(officialChannel, "1.0.0", "9.5.99");
  assert.equal(calls, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.releases.length, 20);
});

test("range notes cache and coalesce reads with a bounded cache", async () => {
  let calls = 0;
  const notes = new ReleaseNotes(async () => {
    calls++;
    return page([release("1.2.0"), release("1.1.0"), release("1.0.0")]);
  });
  const [first, second] = await Promise.all([
    notes.range(officialChannel, "1.0.0", "1.2.0"),
    notes.range(officialChannel, "1.0.0", "1.2.0"),
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  await notes.range(officialChannel, "1.0.0", "1.2.0");
  assert.equal(calls, 1);
  for (let i = 0; i < 25; i++) await notes.range(officialChannel, `0.${i}.0`, "1.2.0");
  assert.ok(notes.rangeCache.size <= 20);
});

test("range notes fall back to the single target notes when the list fails", async () => {
  const urls = [];
  const notes = new ReleaseNotes(async (url) => {
    urls.push(url);
    if (url.includes("/releases?")) return new Response("limited", { status: 403 });
    return Response.json(release("1.24.1"));
  });
  const result = await notes.range(officialChannel, "1.23.0", "1.24.1");
  assert.deepEqual(result.releases, [
    { version: "1.24.1", body: "Notes for 1.24.1", url: tag("1.24.1") },
  ]);
  assert.equal(result.truncated, false);
  assert.ok(urls[1].endsWith("/releases/tags/v1.24.1"));
});

for (const [name, fetchImpl] of [
  [
    "timeout",
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ],
  ["invalid JSON", async () => new Response("invalid")],
  ["non-array JSON", async () => Response.json({ message: "Not Found" })],
  [
    "oversized header",
    async () => new Response("[]", { headers: { "Content-Length": "99999999" } }),
  ],
  ["oversized stream", async () => new Response("x".repeat(3 * 1024 * 1024))],
])
  test(`range notes tolerate ${name} and report the target as unavailable`, async () => {
    const result = await new ReleaseNotes(fetchImpl).range(
      officialChannel,
      "1.23.0",
      "1.24.1",
    );
    assert.deepEqual(result.releases, [
      { version: "1.24.1", body: null, url: tag("1.24.1") },
    ]);
  });

test("range notes accept a full page of release notes within the list limit", async () => {
  const body = "x".repeat(15000);
  const notes = new ReleaseNotes(async () =>
    page([
      ...Array.from({ length: 99 }, (_, i) => release(`1.1.${99 - i}`, { body })),
      release("1.0.0"),
    ]),
  );
  const result = await notes.range(officialChannel, "1.0.0", "1.1.99");
  assert.equal(result.releases.length, 20);
  assert.equal(result.releases[0].body.length, 15000);
});

test("range notes add the target when the list does not contain it yet", async () => {
  const notes = new ReleaseNotes(async (url) =>
    url.includes("/releases?")
      ? page([release("1.24.0"), release("1.23.0")])
      : Response.json(release("1.24.1")),
  );
  const result = await notes.range(officialChannel, "1.23.0", "1.24.1");
  assert.deepEqual(
    result.releases.map((entry) => entry.version),
    ["1.24.1", "1.24.0"],
  );
});

test("range notes stay offline for custom channels and validate versions", async () => {
  const notes = new ReleaseNotes(() => {
    throw Error("Must not fetch");
  });
  assert.deepEqual(await notes.range("https://custom.example/", "1.0.0", "1.1.0"), {
    from: "1.0.0",
    to: "1.1.0",
    releases: [{ version: "1.1.0", body: null, url: null }],
    truncated: false,
    url: null,
  });
  await assert.rejects(notes.range(officialChannel, "../x", "1.1.0"));
  await assert.rejects(notes.range(officialChannel, "1.0.0", "latest"));
});
