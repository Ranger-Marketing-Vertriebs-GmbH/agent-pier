import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Releases } from "../../server/features/operations/releases.js";
import { retryAfterSeconds } from "../../server/features/operations/release-download.js";

const root = "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/";
const entry = (version, extra = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: version.includes("-"),
  assets: [{ name: "latest.json", state: "uploaded" }],
  ...extra,
});
async function fixture(t, entries = [], current = "1.28.0") {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-preview-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data"),
    installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(installRoot, "current"), { recursive: true });
  await fs.writeFile(
    path.join(installRoot, "current/release.json"),
    JSON.stringify({ version: current }),
  );
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.startsWith("https://api.github.com/")) return Response.json(entries);
    if (url.endsWith("latest.json")) {
      const version =
        url === `${root}latest/download/latest.json`
          ? "1.28.0"
          : url.match(/\/v([^/]+)\//)[1];
      return Response.json({
        version,
        schemaVersion: 1,
        artifacts: {
          [`${process.platform}-${process.arch}`]: {
            file: "release.aprelease",
            sha256: "a".repeat(64),
          },
        },
      });
    }
    return new Response("tampered archive");
  };
  const options = { dataDir, installRoot, fetchImpl, channel: "" };
  return { releases: new Releases(options), options, requests };
}

test("stable is the default; opting into preview persists across service restarts", async (t) => {
  const { releases, options } = await fixture(t);
  assert.equal(releases.status().updateChannel, "stable");
  releases.setUpdateChannel("preview");
  assert.equal(new Releases(options).status().updateChannel, "preview");
  assert.throws(() => releases.setUpdateChannel("experimental"), { status: 400 });
  assert.equal(releases.status().updateChannel, "preview");
});

test("preview chooses the highest published RC and ignores drafts, betas and incomplete releases", async (t) => {
  const { releases, requests } = await fixture(t, [
    entry("1.29.0-rc.2"),
    entry("1.29.0-rc.10"),
    entry("1.29.0-rc.1"),
    entry("2.0.0-beta.1"),
    entry("3.0.0-rc.1", { draft: true }),
    entry("4.0.0-rc.1", { assets: [] }),
    entry("1.28.0"),
    entry("bad"),
  ]);
  releases.setUpdateChannel("preview");
  assert.equal((await releases.check()).version, "1.29.0-rc.10");
  await assert.rejects(releases.stage({ version: "1.29.0-rc.10" }), /Prüfsumme/);
  assert.equal(requests.at(-1), `${root}download/v1.29.0-rc.10/release.aprelease`);
});

for (const [entries, current, expected, upToDate] of [
  [[entry("1.29.0-rc.2"), entry("1.29.0")], "1.29.0-rc.2", "1.29.0", false],
  [[entry("1.28.0")], "1.28.0", "1.28.0", true],
  [[], "1.28.0", "1.28.0", true],
])
  test(`preview offers ${expected} from ${current} with ${entries.length} published releases`, async (t) => {
    const { releases } = await fixture(t, entries, current);
    releases.setUpdateChannel("preview");
    const plan = await releases.check();
    assert.equal(plan.version, expected);
    assert.equal(plan.upToDate, upToDate);
  });

test("switching back to stable clears the candidate and never downgrades an installed RC", async (t) => {
  const { releases, requests } = await fixture(t, [entry("1.29.0-rc.2")], "1.29.0-rc.1");
  releases.setUpdateChannel("preview");
  await releases.check();
  releases.setUpdateChannel("stable");
  await assert.rejects(fs.stat(path.join(releases.directory, "candidate.json")), {
    code: "ENOENT",
  });
  requests.length = 0;
  assert.equal((await releases.check()).upToDate, true);
  assert.deepEqual(requests, [`${root}latest/download/latest.json`]);
  await assert.rejects(releases.stage({ version: "1.29.0-rc.2" }), /neuere Version/);
  assert.equal(releases.status().current, "1.29.0-rc.1");
});

test("custom release sources keep their behavior and cannot select official preview", async (t) => {
  const { options } = await fixture(t);
  const releases = new Releases({
    ...options,
    channel: "https://custom.example/releases/",
  });
  assert.equal(releases.status().updateChannelManaged, true);
  assert.throws(() => releases.setUpdateChannel("preview"), { status: 409 });
});

test("preview scans later pages instead of trusting publication order", async (t) => {
  const { releases } = await fixture(t, [entry("1.30.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.fetchImpl = async (url) =>
    new URL(url).searchParams.get("page") === "1"
      ? Response.json(Array.from({ length: 100 }, () => entry("1.28.0")))
      : fetchImpl(url);
  releases.setUpdateChannel("preview");
  assert.equal((await releases.check()).version, "1.30.0-rc.1");
});

test("stable refuses a mistakenly published prerelease manifest", async (t) => {
  const { releases } = await fixture(t);
  const fetchImpl = releases.fetchImpl;
  releases.fetchImpl = () => fetchImpl(`${root}download/v1.29.0-rc.1/latest.json`);
  await assert.rejects(releases.check(), /Manifest/);
});

test("preview rejects mismatched manifests and propagates API failures", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  releases.fetchImpl = (url) =>
    fetchImpl(
      url.includes("v1.29.0-rc.1") ? `${root}download/v1.29.0-rc.2/latest.json` : url,
    );
  await assert.rejects(releases.check(), /Version/);
  releases.fetchImpl = async () => new Response("rate limited", { status: 403 });
  await assert.rejects(releases.check(), { status: 502 });
  await assert.rejects(fs.stat(path.join(releases.directory, "candidate.json")), {
    code: "ENOENT",
  });
});

test("changing the channel during a check rejects the stale result", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  releases.fetchImpl = (url) => {
    releases.setUpdateChannel("stable");
    return fetchImpl(url);
  };
  await assert.rejects(releases.check(), { status: 409 });
  await assert.rejects(fs.stat(path.join(releases.directory, "candidate.json")), {
    code: "ENOENT",
  });
});

test("switching away and back while checking still invalidates the outstanding offer", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  releases.fetchImpl = (url) => {
    releases.setUpdateChannel("stable");
    releases.setUpdateChannel("preview");
    return fetchImpl(url);
  };
  await assert.rejects(releases.check(), { status: 409 });
});

test("changing the channel during download prevents staging the old offer", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  await releases.check();
  releases.fetchImpl = (url) => {
    if (url.endsWith(".aprelease")) releases.setUpdateChannel("stable");
    return fetchImpl(url);
  };
  await assert.rejects(
    releases.stage({ version: "1.29.0-rc.1" }),
    /Release-Kanal hat sich geändert/,
  );
  assert.equal(releases.status().staged.length, 0);
});

for (const assets of [{}, [null]]) {
  test(`preview ignores malformed asset lists: ${JSON.stringify(assets)}`, async (t) => {
    const { releases } = await fixture(t, [
      entry("1.29.0-rc.1", { assets }),
      entry("1.28.0"),
    ]);
    releases.setUpdateChannel("preview");
    assert.equal((await releases.check()).version, "1.28.0");
  });
}

test("official source trailing slashes still pin preview downloads to the selected tag", async (t) => {
  const { options, requests } = await fixture(t, [entry("1.29.0-rc.1")]);
  const releases = new Releases({ ...options, channel: `${root}latest/download///` });
  releases.setUpdateChannel("preview");
  await releases.check();
  await assert.rejects(releases.stage({ version: "1.29.0-rc.1" }), /Prüfsumme/);
  assert.equal(requests.at(-1), `${root}download/v1.29.0-rc.1/release.aprelease`);
});

test("a null channel manifest returns a translated validation error", async (t) => {
  const { releases } = await fixture(t);
  releases.fetchImpl = async () => Response.json(null);
  await assert.rejects(releases.check(), {
    status: 400,
    message: "Das Manifest des Release-Kanals ist ungültig.",
  });
});

test("preview supports the first RC before any stable release exists", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  releases.fetchImpl = async (url) =>
    url === `${root}latest/download/latest.json`
      ? new Response("Not Found", { status: 404 })
      : fetchImpl(url);
  assert.equal((await releases.check()).version, "1.29.0-rc.1");
});

test("preview fails explicitly when pagination cannot complete within its limit", async (t) => {
  const { releases, requests } = await fixture(
    t,
    Array.from({ length: 100 }, () => entry("1.29.0-rc.1")),
  );
  releases.setUpdateChannel("preview");
  await assert.rejects(releases.check(), { status: 503 });
  assert.equal(requests.length, 10);
  await assert.rejects(fs.stat(path.join(releases.directory, "candidate.json")), {
    code: "ENOENT",
  });
});

test("preview includes a stable release published after the list was loaded", async (t) => {
  const { releases } = await fixture(t, [entry("1.28.0-rc.1")], "1.28.0-rc.1");
  releases.setUpdateChannel("preview");
  const plan = await releases.check();
  assert.equal(plan.version, "1.28.0");
  assert.equal(plan.upToDate, false);
});

test("stable upgrades an installed release candidate to its final release", async (t) => {
  const { releases } = await fixture(t, [], "1.29.0-rc.1");
  const fetchImpl = releases.fetchImpl;
  releases.fetchImpl = (url) =>
    fetchImpl(
      url === `${root}latest/download/latest.json`
        ? `${root}download/v1.29.0/latest.json`
        : url,
    );
  const plan = await releases.check();
  assert.equal(plan.updateChannel, "stable");
  assert.equal(plan.version, "1.29.0");
  assert.equal(plan.upToDate, false);
});

test("preview ignores entries whose prerelease flag contradicts the tag", async (t) => {
  const { releases } = await fixture(t, [
    entry("1.29.0-rc.3", { prerelease: false }),
    entry("1.30.0", { prerelease: true }),
    entry("1.28.0"),
  ]);
  releases.setUpdateChannel("preview");
  assert.equal((await releases.check()).version, "1.28.0");
});

test("a damaged channel preference falls back to stable until it is saved again", async (t) => {
  const { releases, options } = await fixture(t);
  const file = path.join(options.dataDir, "operations/release-preferences.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ not json");
  assert.equal(releases.status().updateChannel, "stable");
  assert.equal(releases.setUpdateChannel("stable").updateChannel, "stable");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    updateChannel: "stable",
  });
  assert.equal(releases.setUpdateChannel("preview").updateChannel, "preview");
});

test("an unusable channel preference path fails with a clear error", async (t) => {
  const { releases, options } = await fixture(t);
  const file = path.join(options.dataDir, "operations/release-preferences.json");
  await fs.mkdir(file, { recursive: true });
  assert.throws(() => releases.status(), { status: 413 });
  assert.throws(() => releases.setUpdateChannel("preview"), {
    status: 409,
    message: /Updatekanal konnte nicht gespeichert werden/,
  });
  await fs.rm(file, { recursive: true });
  assert.equal(releases.setUpdateChannel("preview").updateChannel, "preview");
});

test("repeating the selected channel keeps the offer and a running download", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  const fetchImpl = releases.fetchImpl;
  releases.setUpdateChannel("preview");
  await releases.check();
  const revision = releases.channelRevision;
  releases.setUpdateChannel("preview");
  assert.equal(releases.channelRevision, revision);
  await fs.stat(path.join(releases.directory, "candidate.json"));
  releases.fetchImpl = (url) => {
    if (url.endsWith(".aprelease")) releases.setUpdateChannel("preview");
    return fetchImpl(url);
  };
  // The tampered fixture archive proves that staging reached the checksum step.
  await assert.rejects(releases.stage({ version: "1.29.0-rc.1" }), /Prüfsumme/);
  assert.equal(releases.channelRevision, revision);
});

test("an exhausted GitHub API quota reports a rate limit instead of a download failure", async (t) => {
  const { releases } = await fixture(t, [entry("1.29.0-rc.1")]);
  releases.setUpdateChannel("preview");
  const seen = [];
  const reset = String(Math.floor(Date.now() / 1000) + 290);
  for (const [headers, message] of [
    [{ "x-ratelimit-remaining": "0" }, /später erneut/],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, /in 5 Min\./],
    [{ "retry-after": "60" }, /in 1 Min\./],
    [{ "retry-after": "125" }, /in 3 Min\./],
  ])
    for (const status of [403, 429]) {
      releases.fetchImpl = async (url, init) => {
        seen.push(init?.headers?.Accept);
        return new Response("limited", { status, headers });
      };
      await assert.rejects(releases.check(), { status: 503, message });
    }
  assert.ok(seen.every((accept) => accept === "application/vnd.github+json"));
  releases.fetchImpl = async () => new Response("forbidden", { status: 403 });
  await assert.rejects(releases.check(), { status: 502 });
});

test("GitHub retry hints become a wait time in seconds", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const wait = (headers) => retryAfterSeconds(new Headers(headers), now);
  assert.equal(wait({ "retry-after": "30" }), 30);
  assert.equal(wait({ "retry-after": "Tue, 13 Oct 2026 12:02:00 GMT" }), 120);
  assert.equal(wait({ "x-ratelimit-reset": String(now / 1000 + 600) }), 600);
  assert.equal(wait({ "x-ratelimit-reset": String(now / 1000 - 5) }), 1);
  assert.equal(wait({ "retry-after": "soon" }), null);
  assert.equal(wait({}), null);
});
