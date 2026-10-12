import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  CLI_CONFIG_LAYOUT,
  editConfig,
} from "../../server/features/extensions/config-edit.js";

const data = (tool, text) =>
  !text.trim() ? {} : tool === "codex" ? parseToml(text) : parseJsonc(text);
const edit = (tool, key, text, name, entry) =>
  editConfig({ text, data: data(tool, text) }, tool, key, name, entry);
const entry = { url: "https://mcp.example.test/mcp", headers: { A: "1" } };

const cases = {
  claude: [
    "",
    "{}",
    "{}\n",
    '{"theme":"x"}',
    '{\n  "theme": "x",\n  "mcpServers": {}\n}\n',
    '{\n  "mcpServers": {\n    "mine": { "command": "a" }\n  },\n  "z": 1\n}\n',
    '{ "mcpServers": { "mine": { "command": "a" } } }',
  ],
  opencode: [
    "{\n  // c\n}\n",
    '{\n  "mcp": {\n    // only a comment\n  },\n}\n',
    '{\n  "mcp": { "mine": { "type": "local", "command": ["a"] }, },\n}\n',
    '{\n  "mcp": {\n    "mine": {}, /* after */\n  }\n}\n',
  ],
  codex: [
    "",
    'model = "x"',
    'model = "x"\n',
    "[mcp_servers]\n",
    '[mcp_servers]\nmine = { command = "a" }\n\n[other]\nk = 1.0\n',
    'mcp_servers.mine.command = "a"\n[other]\nk = 1\n',
    "# only a comment\n",
  ],
};
const keys = { claude: "mcpServers", codex: "mcp_servers", opencode: "mcp" };

for (const [tool, texts] of Object.entries(cases))
  for (const text of texts)
    test(`${tool}: set then remove restores ${JSON.stringify(text)}`, () => {
      const key = keys[tool];
      const set = edit(tool, key, text, "docs", entry);
      assert.deepEqual(JSON.parse(JSON.stringify(data(tool, set)[key].docs)), entry);
      const replaced = edit(tool, key, set, "docs", { ...entry, url: "https://b.test/" });
      assert.equal(data(tool, replaced)[key].docs.url, "https://b.test/");
      const removed = edit(tool, key, replaced, "docs", undefined);
      // A file without the MCP key keeps the emptied MCP object; TOML has none and
      // gains at most a final newline.
      if (tool !== "codex" && data(tool, text)[key] === undefined) {
        assert.deepEqual(data(tool, removed), { ...data(tool, text), [key]: {} });
        const squeeze = (value) =>
          value.replace(new RegExp(`,?\\s*"${key}": \\{\\}`), "").replace(/\s+/g, "");
        assert.equal(squeeze(removed), squeeze(text) || "{}");
      } else if (!text.trim()) assert.deepEqual(data(tool, removed), {});
      else
        assert.equal(
          removed,
          tool === "codex" && !text.endsWith("\n") ? `${text}\n` : text,
        );
      assert.equal(data(tool, removed)[key]?.docs, undefined);
    });

test("codex: an entry defined inline or by dotted keys is replaced by a table", () => {
  const text =
    '[mcp_servers]\ndocs = { url = "https://old.test/" }\nmine = { command = "a" }\n';
  const set = edit("codex", "mcp_servers", text, "docs", { url: "https://new.test/" });
  assert.ok(set.includes('mine = { command = "a" }\n'));
  assert.equal(parseToml(set).mcp_servers.docs.url, "https://new.test/");
  const dotted = 'mcp_servers.docs.url = "https://old.test/"\nmodel = "x"\n';
  const out = edit("codex", "mcp_servers", dotted, "docs", undefined);
  assert.equal(out, 'model = "x"\n');
});

test("a structure that cannot be edited in place is refused", () => {
  assert.throws(() => edit("codex", "mcp_servers", "mcp_servers = {}\n", "docs", entry), {
    code: CLI_CONFIG_LAYOUT,
  });
  assert.throws(() => edit("claude", "mcpServers", '{"mcpServers": []}', "docs", entry), {
    code: CLI_CONFIG_LAYOUT,
  });
});
