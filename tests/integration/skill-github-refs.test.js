import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ExtensionsStore } from "../../server/features/extensions/extension-store.js";
import { previewAndInstall } from "../helpers/skill-import.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const content =
  "---\nname: demo-skill\ndescription: A fixture skill for tests.\n---\n# Instructions\n";
const commit = "0123456789abcdef0123456789abcdef01234567";
const tagObject = "fedcba9876543210fedcba9876543210fedcba98";

function archive(top) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import sys,json,zipfile,io,base64\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n for n,v in json.loads(sys.stdin.read()).items(): z.writestr(n,v)\nprint(base64.b64encode(b.getvalue()).decode())",
    ],
    {
      input: JSON.stringify({ [`${top}/skills/demo/SKILL.md`]: content }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), "base64");
}

/** A fake GitHub: `refs` maps an API path to its JSON; codeload answers every zip. */
function setup(t, refs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-skill-refs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home });
  const calls = [];
  const fetchImpl = async (url, options) => {
    const href = String(url);
    calls.push({ url: href, options });
    if (href.startsWith("https://codeload.github.com/"))
      return new Response(archive(`repo-${href.split("/").at(-1)}`));
    const found = refs[new URL(href).pathname];
    return found ? Response.json(found) : new Response("{}", { status: 404 });
  };
  return { calls, home, store: new ExtensionsStore({ accounts, home, fetchImpl }) };
}
const api = "/repos/example/repo/git";

test("a commit SHA in a tree link downloads exactly that commit without a lookup", async (t) => {
  const { store, calls } = setup(t);
  const installed = await previewAndInstall(store, "local-claude", {
    url: `https://github.com/example/repo/tree/${commit.toUpperCase()}/skills/demo`,
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [`https://codeload.github.com/example/repo/zip/${commit}`],
  );
  assert.deepEqual(installed.origin, {
    kind: "github",
    repository: "example/repo",
    ref: commit,
    refKind: "commit",
    commit,
  });
  assert.equal(store.list("local-claude").skills.items[0].origin.commit, commit);
});

test("a tag resolves through its annotated tag object and pins the commit", async (t) => {
  const { store, calls } = setup(t, {
    [`${api}/ref/tags/v1.2.0`]: { object: { type: "tag", sha: tagObject } },
    [`${api}/tags/${tagObject}`]: { object: { type: "commit", sha: commit } },
  });
  const installed = await previewAndInstall(store, "local-claude", {
    url: "https://github.com/example/repo/tree/v1.2.0/skills/demo",
  });
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      "https://api.github.com/repos/example/repo/git/ref/heads/v1.2.0",
      "https://api.github.com/repos/example/repo/git/ref/tags/v1.2.0",
      `https://api.github.com/repos/example/repo/git/tags/${tagObject}`,
      `https://codeload.github.com/example/repo/zip/${commit}`,
    ].sort(),
  );
  for (const call of calls) {
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.headers.Authorization, undefined);
  }
  assert.equal(installed.origin.refKind, "tag");
  assert.equal(installed.origin.ref, "v1.2.0");
  assert.equal(installed.origin.commit, commit);
});

test("a branch pins the commit it points to when the skill is installed", async (t) => {
  const { store, calls } = setup(t, {
    [`${api}/ref/heads/main`]: { object: { type: "commit", sha: commit } },
  });
  const installed = await previewAndInstall(store, "local-claude", {
    url: "https://github.com/example/repo/tree/main/skills/demo",
  });
  assert.equal(
    calls.at(-1).url,
    `https://codeload.github.com/example/repo/zip/${commit}`,
  );
  assert.equal(installed.origin.refKind, "branch");
  assert.equal(installed.origin.commit, commit);
});

test("an ambiguous, unknown or malformed ref downloads nothing", async (t) => {
  const both = setup(t, {
    [`${api}/ref/heads/v1`]: { object: { type: "commit", sha: commit } },
    [`${api}/ref/tags/v1`]: { object: { type: "commit", sha: commit } },
    [`${api}/ref/heads/bad`]: { object: { type: "commit", sha: "not-a-sha" } },
  });
  await assert.rejects(
    previewAndInstall(both.store, "local-claude", {
      url: "https://github.com/example/repo/tree/v1/skills/demo",
    }),
    { status: 400, message: serverMessages.extensions.skillRefAmbiguous },
  );
  await assert.rejects(
    previewAndInstall(both.store, "local-claude", {
      url: "https://github.com/example/repo/tree/missing/skills/demo",
    }),
    { status: 400, message: serverMessages.extensions.skillRefNotFound },
  );
  await assert.rejects(
    previewAndInstall(both.store, "local-claude", {
      url: "https://github.com/example/repo/tree/bad/skills/demo",
    }),
    { status: 502 },
  );
  assert.equal(
    both.calls.some((call) => call.url.startsWith("https://codeload.github.com/")),
    false,
  );
  assert.equal(fs.existsSync(path.join(both.home, ".claude/skills/demo-skill")), false);
});

test("a ref lookup never follows a redirect off api.github.com", async (t) => {
  const { store, calls } = setup(t);
  store.fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.invalid/x" },
    });
  };
  await assert.rejects(
    previewAndInstall(store, "local-claude", {
      url: "https://github.com/example/repo/tree/main/skills/demo",
    }),
    { status: 400 },
  );
  assert.equal(
    calls.some((call) => call.url.includes("attacker")),
    false,
  );
});

test("a rate-limited or oversized ref lookup names the reason and downloads nothing", async (t) => {
  const { store, calls } = setup(t);
  const url = "https://github.com/example/repo/tree/main/skills/demo";
  for (const limited of [
    () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    () => new Response("{}", { status: 429 }),
  ]) {
    store.fetchImpl = async (target, options) => {
      calls.push({ url: String(target), options });
      return limited();
    };
    await assert.rejects(previewAndInstall(store, "local-claude", { url }), {
      status: 429,
      message: serverMessages.extensions.skillRefRateLimited,
    });
  }
  store.fetchImpl = async (target) => {
    calls.push({ url: String(target) });
    return new Response(`{"pad":"${"x".repeat(70 * 1024)}"}`);
  };
  await assert.rejects(previewAndInstall(store, "local-claude", { url }), {
    status: 502,
    message: serverMessages.extensions.skillRefLookupFailed,
  });
  assert.equal(
    calls.some((call) => call.url.startsWith("https://codeload.github.com/")),
    false,
  );
});
