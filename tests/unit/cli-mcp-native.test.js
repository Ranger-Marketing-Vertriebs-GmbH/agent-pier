import test from "node:test";
import assert from "node:assert/strict";
import { cases } from "../fixtures/cli-mcp-shapes.js";
import {
  canonicalJson,
  centralFromNative,
  cliEntry,
  cliSupport,
  clis,
  contentKey,
  entryHash,
  proposeName,
} from "../../server/features/mcp-servers/cli-native.js";

test("every pinned native entry is exactly what AgentPier projects", () => {
  for (const item of cases)
    for (const cli of clis) {
      const support = cliSupport(cli, item.central);
      if (item.unsupported?.[cli]) {
        assert.deepEqual(
          support,
          { supported: false, reason: item.unsupported[cli] },
          `${item.id}/${cli}`,
        );
        continue;
      }
      assert.equal(support.supported, true, `${item.id}/${cli}`);
      assert.deepEqual(
        cliEntry(cli, item.central, item.secrets),
        item.native[cli],
        `${item.id}/${cli}`,
      );
    }
});

test("the stdio working directory is refused for Claude Code only", () => {
  const item = cases.find((entry) => entry.id === "stdio-cwd");
  assert.equal(cliSupport("opencode", item.central).supported, true);
  assert.equal(cliSupport("codex", item.central).supported, true);
  assert.deepEqual(cliSupport("claude", item.central), {
    supported: false,
    reason: "cwd",
  });
  assert.equal(item.native.opencode.cwd, "/tmp");
});

test("a pinned native entry parses back into the same projection", () => {
  for (const item of cases)
    for (const [cli, native] of Object.entries(item.native)) {
      const parsed = centralFromNative(cli, native);
      assert.equal(parsed.ok, true, `${item.id}/${cli}`);
      assert.deepEqual(
        cliEntry(cli, parsed.definition, parsed.secrets),
        native,
        `${item.id}/${cli}`,
      );
    }
});

test("identical content from different CLIs has one content key", () => {
  const http = cases.find((item) => item.id === "http").native;
  const keys = ["claude", "codex", "opencode"].map((cli) =>
    contentKey(centralFromNative(cli, http[cli])),
  );
  assert.equal(new Set(keys).size, 1);
  const other = centralFromNative("claude", {
    ...http.claude,
    url: "https://other.example.test/mcp",
  });
  assert.notEqual(contentKey(other), keys[0]);
});

test("entries AgentPier cannot represent are not adoptable, by reason", () => {
  assert.deepEqual(
    centralFromNative("codex", { url: "https://x.test/mcp", startup_timeout_sec: 5 }),
    {
      ok: false,
      reason: "unsupported-fields",
      keys: ["startup_timeout_sec"],
    },
  );
  assert.equal(
    centralFromNative("opencode", {
      type: "remote",
      url: "https://x.test/mcp",
      enabled: false,
    }).reason,
    "unsupported-fields",
  );
  assert.equal(
    centralFromNative("claude", { type: "ws", url: "wss://x.test" }).reason,
    "unsupported-fields",
  );
  assert.equal(
    centralFromNative("claude", { type: "http", url: "https://u:p@x.test/mcp" }).reason,
    "invalid",
  );
  assert.equal(centralFromNative("codex", { command: "" }).reason, "invalid");
  assert.equal(centralFromNative("claude", "not an object").reason, "invalid");
});

test("entries with environment references are not adoptable and name only where", () => {
  const refused = (cli, entry) => centralFromNative(cli, entry);
  assert.deepEqual(
    refused("claude", {
      type: "http",
      url: "https://x.test/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}", Accept: "json" },
    }),
    { ok: false, reason: "env-references", names: ["Authorization"] },
  );
  assert.deepEqual(
    refused("claude", {
      type: "stdio",
      command: "/bin/tool",
      args: ["--root", "${HOME:-/tmp}"],
      env: { TOKEN: "${TOKEN:-fallback-secret}", PLAIN: "keep" },
    }),
    { ok: false, reason: "env-references", names: ["args", "TOKEN"] },
  );
  assert.deepEqual(
    refused("opencode", {
      type: "remote",
      url: "https://x.test/mcp",
      headers: { "X-Key": "{env:SEARCH_KEY}" },
    }),
    { ok: false, reason: "env-references", names: ["X-Key"] },
  );
  assert.deepEqual(
    refused("opencode", {
      type: "local",
      command: ["/bin/tool"],
      environment: { KEY: "{file:~/.secrets/key}" },
    }),
    { ok: false, reason: "env-references", names: ["KEY"] },
  );
  assert.deepEqual(refused("codex", { url: "https://x.test/${HOST}/mcp" }), {
    ok: false,
    reason: "env-references",
    names: ["url"],
  });
  // Codex forwards variables by name only: settings AgentPier does not manage.
  assert.equal(
    refused("codex", { url: "https://x.test/mcp", bearer_token_env_var: "TOKEN" }).reason,
    "unsupported-fields",
  );
  assert.equal(
    refused("codex", { command: "/bin/tool", env_vars: ["TOKEN"] }).reason,
    "unsupported-fields",
  );
  // A dollar or brace that is no reference stays adoptable.
  assert.equal(
    refused("claude", {
      type: "http",
      url: "https://x.test/mcp",
      headers: { Authorization: "Bearer a$b{c}{envx:y}" },
    }).ok,
    true,
  );
});

test("the hash is canonical: key order and absent keys do not matter, values do", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }),
    '{"a":[{"c":3,"d":2}],"b":1}',
  );
  assert.equal(entryHash({ a: 1, b: undefined }), entryHash({ a: 1 }));
  assert.equal(
    entryHash({ url: "u", headers: { A: "1" } }),
    entryHash({ headers: { A: "1" }, url: "u" }),
  );
  assert.notEqual(entryHash({ headers: { A: "1" } }), entryHash({ headers: { A: "2" } }));
  assert.match(entryHash({}), /^[0-9a-f]{64}$/);
});

test("name proposals are valid, free and keep a valid free name", () => {
  const taken = new Set(["docs", "docs-2"]);
  assert.equal(proposeName("search", taken), "search");
  assert.equal(proposeName("Docs", taken), "Docs-3");
  assert.equal(proposeName("my.server", taken), "my-server");
  assert.equal(proposeName("1password", taken), "password");
  assert.equal(proposeName("***", taken), "mcp");
  assert.equal(proposeName("a".repeat(40), taken), "a".repeat(30));
});
