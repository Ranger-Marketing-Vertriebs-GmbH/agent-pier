import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ExtensionsStore } from "../../server/features/extensions/extension-store.js";
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-extensions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home });
  assert.equal(
    typeof ExtensionsStore,
    "function",
    "ExtensionsStore implements native CLI extension management",
  );
  return {
    root,
    home,
    accounts,
    store: new ExtensionsStore({ accounts, home, ...options }),
  };
}
const content =
  "---\nname: demo-skill\ndescription: A fixture skill for tests.\n---\n# Instructions\nRead the bundled guide.\n";
function zip(files) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import sys,json,zipfile,io,base64\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n for n,v in json.loads(sys.stdin.read()).items():\n  i=zipfile.ZipInfo(n);i.external_attr=((0o120777 if isinstance(v,dict) else 0o100644)<<16);z.writestr(i,v['link'] if isinstance(v,dict) else v)\nprint(base64.b64encode(b.getvalue()).decode())`,
    ],
    { input: JSON.stringify(files), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} MCP config uses the selected native profile and preserves unrelated settings`, (t) => {
    const { home, accounts, store } = setup(t);
    const account = accounts.create({ name: "Fixture", tool });
    const initial = store.list(account.id);
    const file = initial.mcp.path;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      tool === "claude"
        ? JSON.stringify({
            theme: "keep-me",
            projects: { "/fixture": { trusted: true } },
          })
        : tool === "codex"
          ? 'model = "keep-me"\n[projects."/fixture"]\ntrust_level = "trusted"\n'
          : '{\n // keep this comment\n "theme":"keep-me", "projects":{"/fixture":{"trusted":true}}\n}\n',
    );
    const added = store.addMcp(account.id, {
      name: "fixture",
      transport: "stdio",
      command: "fixture-command",
      args: ["--token", "private-arg"],
      env: { API_KEY: "private-key" },
    });
    const parsed =
      tool === "codex"
        ? parseToml(fs.readFileSync(file, "utf8"))
        : parseJsonc(fs.readFileSync(file, "utf8"));
    assert.equal(tool === "codex" ? parsed.model : parsed.theme, "keep-me");
    assert.ok(parsed.projects["/fixture"]);
    const server =
      parsed[tool === "codex" ? "mcp_servers" : tool === "claude" ? "mcpServers" : "mcp"]
        .fixture;
    assert.equal(
      tool === "opencode" ? server.command[0] : server.command,
      "fixture-command",
    );
    assert.equal((server.env || server.environment).API_KEY, "private-key");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(added).includes("private-"), false);
    assert.equal(store.list(account.id).mcp.servers[0].argumentCount, 2);
    assert.throws(
      () =>
        store.addMcp(account.id, {
          name: "fixture",
          transport: "http",
          url: "https://example.invalid/mcp",
        }),
      { status: 409 },
    );
    store.removeMcp(account.id, "fixture");
    assert.equal(store.list(account.id).mcp.servers.length, 0);
    assert.equal(
      fs.existsSync(
        path.join(
          home,
          tool === "codex"
            ? ".codex/config.toml"
            : tool === "claude"
              ? ".claude.json"
              : ".config/opencode/opencode.jsonc",
        ),
      ),
      false,
    );
  });
test("MCP remote headers are native, redacted, and invalid config is never overwritten", (t) => {
  const { store, home } = setup(t);
  const id = "local-codex";
  store.addMcp(id, {
    name: "remote",
    transport: "http",
    url: "https://example.invalid/mcp?key=private-query",
    headers: { Authorization: "Bearer private-header" },
  });
  const list = store.list(id);
  assert.equal(JSON.stringify(list).includes("private-"), false);
  const raw = fs.readFileSync(list.mcp.path, "utf8");
  assert.equal(
    parseToml(raw).mcp_servers.remote.http_headers.Authorization,
    "Bearer private-header",
  );
  fs.writeFileSync(list.mcp.path, "invalid = [");
  assert.throws(
    () =>
      store.addMcp(id, {
        name: "other",
        transport: "http",
        url: "https://example.invalid/mcp",
      }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(list.mcp.path, "utf8"), "invalid = [");
  fs.rmSync(list.mcp.path);
  const outside = path.join(home, "outside");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, list.mcp.path);
  assert.throws(
    () =>
      store.addMcp(id, {
        name: "other",
        transport: "http",
        url: "https://example.invalid/mcp",
      }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});
test("ZIP install retains related files, lists other sources read-only, rejects overwrite and removes only owned folder", async (t) => {
  const { store, home } = setup(t);
  const external = path.join(home, ".agents/skills/external");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(
    path.join(external, "SKILL.md"),
    content.replaceAll("demo-skill", "external"),
  );
  const installed = await store.installSkill("local-codex", {
    fileName: "skill.zip",
    contentBase64: zip({
      "bundle/demo/SKILL.md": content,
      "bundle/demo/references/guide.md": "Guide content",
      "bundle/LICENSE": "license",
    }),
  });
  assert.equal(
    fs.readFileSync(path.join(installed.path, "references/guide.md"), "utf8"),
    "Guide content",
  );
  assert.equal(
    store.list("local-codex").skills.items.find((s) => s.name === "external").removable,
    false,
  );
  assert.equal(
    store.list("local-codex").skills.items.find((s) => s.name === "demo-skill").removable,
    true,
  );
  await assert.rejects(
    store.installSkill("local-codex", {
      fileName: "SKILL.md",
      contentBase64: Buffer.from(content).toString("base64"),
    }),
    { status: 409 },
  );
  assert.throws(() => store.removeSkill("local-codex", "external"), { status: 404 });
  store.removeSkill("local-codex", installed.id);
  assert.equal(fs.existsSync(installed.path), false);
  assert.equal(fs.existsSync(external), true);
});
test("skill packages reject traversal, symlinks, multiple roots, invalid metadata and oversized content", async (t) => {
  const { store, home } = setup(t);
  for (const files of [
    { "../outside": "bad", "SKILL.md": content },
    { "SKILL.md": content, link: { link: "/tmp/outside" } },
    { "a/SKILL.md": content, "b/SKILL.md": content },
    { "SKILL.md": content.replace("name: demo-skill", "name: ../../escape") },
    { "SKILL.md": "# No frontmatter" },
    { "SKILL.md": content, ".claude-plugin/plugin.json": "{}" },
  ])
    await assert.rejects(
      store.installSkill("local-claude", {
        fileName: "skill.zip",
        contentBase64: zip(files),
      }),
      { status: 400 },
    );
  await assert.rejects(
    store.installSkill("local-claude", {
      fileName: "SKILL.md",
      contentBase64: "not base64",
    }),
    { status: 400 },
  );
  assert.equal(fs.existsSync(path.join(home, ".claude/skills/demo-skill")), false);
});
test("GitHub tree downloads use trusted archive endpoint without ambient authentication", async (t) => {
  const calls = [];
  const archive = Buffer.from(
    zip({
      "repo-main/skills/demo/SKILL.md": content,
      "repo-main/skills/demo/guide.md": "hello",
      "repo-main/skills/other/SKILL.md": content.replaceAll("demo-skill", "other"),
    }),
    "base64",
  );
  const { store } = setup(t, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(archive);
    },
  });
  const installed = await store.installSkill("local-opencode", {
    url: "https://github.com/example/repo/tree/main/skills/demo",
  });
  assert.equal(installed.name, "demo-skill");
  assert.equal(
    calls[0].url,
    "https://codeload.github.com/example/repo/zip/refs/heads/main",
  );
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(fs.readFileSync(path.join(installed.path, "guide.md"), "utf8"), "hello");
  for (const url of [
    "http://github.com/example/repo",
    "https://github.com.evil/example/repo",
    "https://user:secret@github.com/example/repo",
    "https://127.0.0.1/private",
    "https://codeload.github.com:444/a/b/zip/main",
  ])
    await assert.rejects(store.installSkill("local-opencode", { url }), { status: 400 });
});
test("download redirects cannot escape allowed GitHub origins", async (t) => {
  let calls = 0;
  const { store } = setup(t, {
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.invalid/private" },
      });
    },
  });
  await assert.rejects(
    store.installSkill("local-codex", {
      url: "https://github.com/example/repo/archive/refs/heads/main.zip",
    }),
    { status: 400 },
  );
  assert.equal(calls, 1);
});

test("OpenCode removal refuses duplicate definitions rather than reactivating a shadowed server", (t) => {
  const { store, home } = setup(t);
  const dir = path.join(home, ".config/opencode");
  fs.mkdirSync(dir, { recursive: true });
  const base = JSON.stringify({
    mcp: { fixture: { type: "local", command: ["old-server"] } },
  });
  const top = JSON.stringify({
    mcp: { fixture: { type: "local", command: ["new-server"] } },
  });
  fs.writeFileSync(path.join(dir, "opencode.json"), base);
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), top);
  assert.throws(() => store.removeMcp("local-opencode", "fixture"), { status: 409 });
  assert.equal(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), base);
  assert.equal(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"), top);
});
test("ZIP skills preserve executable scripts without running them during installation", async (t) => {
  const { store } = setup(t);
  const encoded = spawnSync(
    "python3",
    [
      "-c",
      `import zipfile,io,base64,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('SKILL.md',sys.stdin.read())\n i=zipfile.ZipInfo('scripts/run.sh');i.external_attr=0o100755<<16;z.writestr(i,'#!/bin/sh\\ntouch ran-script\\n')\nprint(base64.b64encode(b.getvalue()).decode())`,
    ],
    { input: content, encoding: "utf8" },
  ).stdout.trim();
  const installed = await store.installSkill("local-claude", {
    fileName: "demo.zip",
    contentBase64: encoded,
  });
  assert.equal(
    fs.statSync(path.join(installed.path, "scripts/run.sh")).mode & 0o777,
    0o700,
  );
  assert.equal(fs.existsSync(path.join(installed.path, "ran-script")), false);
});

test("managed symlinked config roots are rejected before profile initialization can modify their target", (t) => {
  const { store, accounts, root } = setup(t);
  const account = accounts.create({ name: "Fixture", tool: "claude" });
  const dir = path.join(accounts.profile(account.id), "claude");
  fs.rmSync(dir, { recursive: true });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { mode: 0o755 });
  // Explicit permissions keep this regression sensitive under restrictive umasks.
  fs.chmodSync(outside, 0o755);
  fs.symlinkSync(outside, dir);
  assert.throws(
    () =>
      store.addMcp(account.id, {
        name: "safe",
        transport: "stdio",
        command: "fixture",
        args: [],
      }),
    { status: 409 },
  );
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test("preexisting skills remain visible even when metadata needs review", (t) => {
  const { store, home } = setup(t);
  const dir = path.join(home, ".claude/skills/legacy");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# Legacy instructions\nDo work.");
  const item = store
    .list("local-claude")
    .skills.items.find((item) => item.name === "legacy");
  assert.ok(item);
  assert.equal(item.removable, false);
  assert.match(item.description, /Metadaten/);
});
test("Codex MCP editing retains unrelated comments and dotted quoted configuration", (t) => {
  const { store, home } = setup(t);
  const file = path.join(home, ".codex/config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unrelated =
    '# Keep this exact comment\nmodel = "fixture" # model comment\n[projects."/space path"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(
    file,
    unrelated +
      '\n[mcp_servers."a.b"]\ncommand = "fixture-command"\n[mcp_servers."a.b".env]\nKEY = "secret"\n',
  );
  store.addMcp("local-codex", {
    name: "other",
    transport: "http",
    url: "https://example.invalid/mcp",
  });
  assert.equal(fs.readFileSync(file, "utf8").startsWith(unrelated), true);
  store.removeMcp("local-codex", "a.b");
  assert.equal(parseToml(fs.readFileSync(file, "utf8")).mcp_servers["a.b"], undefined);
  assert.equal(fs.readFileSync(file, "utf8").startsWith(unrelated), true);
});

test("oversized ZIP expansion is rejected before writing any skill files", async (t) => {
  const { store, home } = setup(t);
  const encoded = spawnSync(
    "python3",
    [
      "-c",
      `import zipfile,io,base64,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n z.writestr('SKILL.md',sys.stdin.read());z.writestr('oversized.txt','x'*(20*1024*1024+1))\nprint(base64.b64encode(b.getvalue()).decode())`,
    ],
    { input: content, encoding: "utf8", maxBuffer: 1024 * 1024 },
  ).stdout.trim();
  await assert.rejects(
    store.installSkill("local-claude", { fileName: "demo.zip", contentBase64: encoded }),
    { status: 400 },
  );
  assert.equal(fs.existsSync(path.join(home, ".claude/skills/demo-skill")), false);
});
test("server shutdown cancels a pending skill download without an installed directory", async (t) => {
  let start;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const { store, home } = setup(t, {
    fetchImpl: async (url, { signal }) =>
      new Promise((resolve, reject) => {
        start();
        signal.addEventListener("abort", () => reject(new Error("abort")), {
          once: true,
        });
      }),
  });
  const pending = store.installSkill("local-codex", {
    url: "https://github.com/example/skill",
  });
  const rejected = assert.rejects(pending, { status: 502 });
  await started;
  await store.close();
  await rejected;
  assert.equal(fs.existsSync(path.join(home, ".agents/skills/demo-skill")), false);
  await assert.rejects(
    store.installSkill("local-codex", {
      fileName: "SKILL.md",
      contentBase64: Buffer.from(content).toString("base64"),
    }),
    { status: 503 },
  );
});

test("ambiguous JSONC keys and non-JSON Claude config are rejected without rewriting", (t) => {
  const { store, home } = setup(t);
  const opencode = path.join(home, ".config/opencode/opencode.jsonc");
  fs.mkdirSync(path.dirname(opencode), { recursive: true });
  const duplicate = '{"mcp":{"old":{"type":"local","command":["keep"]}},"mcp":{}}';
  fs.writeFileSync(opencode, duplicate);
  assert.throws(
    () =>
      store.addMcp("local-opencode", {
        name: "new",
        transport: "stdio",
        command: "fixture",
      }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(opencode, "utf8"), duplicate);
  const claude = path.join(home, ".claude.json");
  const invalid = '{/* comment not accepted by Claude */"theme":"keep"}';
  fs.writeFileSync(claude, invalid);
  assert.throws(
    () =>
      store.addMcp("local-claude", {
        name: "new",
        transport: "stdio",
        command: "fixture",
      }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(claude, "utf8"), invalid);
});
