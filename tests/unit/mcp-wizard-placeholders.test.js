import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fc from "fast-check";
import * as server from "../../server/features/mcp-servers/agent-placeholders.js";
import {
  draftUsesPlaceholders,
  looksLikePath,
  parsePlaceholder,
  placeholderNames,
} from "../../web/features/mcp-servers/agent-placeholders.js";

test("the form knows exactly the server's placeholders and patterns", () => {
  assert.deepEqual(placeholderNames, server.placeholderNames);
  const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const pattern = (source, name) =>
    new RegExp(`const ${name} = (/.*/i?);`).exec(source)[1];
  const serverSource = read("../../server/features/mcp-servers/agent-placeholders.js");
  const webSource = read("../../web/features/mcp-servers/agent-placeholders.js");
  for (const name of ["candidate", "shape", "badSegment"])
    assert.equal(pattern(webSource, name), pattern(serverSource, name), name);
});

test("form and server parse every value alike", () => {
  const pieces = fc.constantFrom(
    "{agent.workspace}",
    "{agent.attachments}",
    "{agent.",
    "{session.cwd}",
    "{",
    "}",
    "/",
    "..",
    ".",
    "a",
    "--dir=",
    " ",
    "\u0001",
  );
  fc.assert(
    fc.property(
      fc.array(pieces, { maxLength: 8 }).map((parts) => parts.join("")),
      fc.boolean(),
      (value, prefix) =>
        assert.deepEqual(
          parsePlaceholder(value, { prefix }),
          server.parsePlaceholder(value, { prefix }),
          value,
        ),
    ),
    { numRuns: 3000 },
  );
});

test("a draft uses placeholders in arguments, cwd, typed or kept stored settings", () => {
  const base = { transport: "stdio", argRows: [], cwd: "", env: [] };
  assert.equal(draftUsesPlaceholders(base), false);
  assert.equal(
    draftUsesPlaceholders({ ...base, argRows: ["--o={agent.workspace}"] }),
    true,
  );
  assert.equal(
    draftUsesPlaceholders({ ...base, args: "a\n{agent.workspace}", argRows: undefined }),
    true,
  );
  assert.equal(draftUsesPlaceholders({ ...base, cwd: "{agent.workspace}" }), true);
  const typed = { key: "1", name: "BASE", value: "{agent.attachments}" };
  assert.equal(draftUsesPlaceholders({ ...base, env: [typed] }), true);
  const stored = { key: "2", name: "BASE", value: "", stored: true, removed: false };
  const saved = { placeholders: { env: { BASE: "{agent.attachments}" } } };
  assert.equal(draftUsesPlaceholders({ ...base, env: [stored] }, saved), true);
  assert.equal(
    draftUsesPlaceholders({ ...base, env: [{ ...stored, removed: true }] }, saved),
    false,
  );
  assert.equal(
    draftUsesPlaceholders({ ...base, env: [{ ...stored, value: "/x" }] }, saved),
    false,
  );
  assert.equal(
    draftUsesPlaceholders({ ...base, transport: "http", cwd: "{agent.workspace}" }),
    false,
  );
});

test("path-like setting names get the folder offer", () => {
  for (const name of ["ELEVENLABS_MCP_BASE_PATH", "OUTPUT_DIR", "DATA_FOLDER", "root"])
    assert.equal(looksLikePath(name), true, name);
  for (const name of ["API_KEY", "MODE", ""])
    assert.equal(looksLikePath(name), false, name);
});
