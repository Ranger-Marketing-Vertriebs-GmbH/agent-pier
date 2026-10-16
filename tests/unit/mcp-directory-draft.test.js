import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  composeUrl,
  draftFromEntry,
  isSelectable,
} from "../../web/features/mcp-servers/wizard/directory-draft.js";

const input = (name, extra = {}) => ({
  name,
  description: "",
  required: false,
  secret: false,
  format: "string",
  default: null,
  choices: [],
  value: null,
  variables: [],
  ...extra,
});
const entry = (options) => ({
  name: "io.github.example/opnsense-mcp-server",
  title: "OPNsense",
  version: "0.4.1",
  options,
});

test("an npm option becomes a package draft with its settings as hints", () => {
  const draft = draftFromEntry(
    entry([]),
    {
      kind: "npm",
      identifier: "opnsense-mcp-server",
      version: "0.4.1",
      packageArgs: ["--log-level", "info"],
      env: [
        input("OPNSENSE_API_KEY", {
          description: "API key",
          required: true,
          secret: true,
        }),
        input("OPNSENSE_VERIFY_SSL", { format: "boolean", default: "true" }),
        input("MODE", { choices: ["read", "write"] }),
      ],
    },
    { taken: ["opnsense-mcp-server"] },
  );
  assert.equal(draft.path, "package");
  assert.equal(draft.name, "opnsense-mcp-server-2");
  assert.deepEqual(
    [draft.registry, draft.packageName, draft.packageVersion],
    ["npm", "opnsense-mcp-server", "0.4.1"],
  );
  assert.deepEqual(draft.argRows, ["--log-level", "info"]);
  assert.deepEqual(
    draft.env.map((row) => [row.name, row.value, row.fixed]),
    [
      ["OPNSENSE_API_KEY", "", true],
      ["OPNSENSE_VERIFY_SSL", "", true],
      ["MODE", "", true],
    ],
  );
  assert.deepEqual(draft.hints.settings.OPNSENSE_API_KEY, {
    description: "API key",
    required: true,
    secret: true,
  });
  assert.deepEqual(draft.hints.settings.OPNSENSE_VERIFY_SSL, {
    description: "",
    required: false,
    secret: false,
    format: "boolean",
    default: "true",
  });
  assert.deepEqual(draft.hints.settings.MODE.choices, ["read", "write"]);
  assert.deepEqual(draft.directoryOrigin, {
    name: "io.github.example/opnsense-mcp-server",
    version: "0.4.1",
  });
  assert.equal(draft.origin, "directory");
});

test("a fixed literal value is kept, a templated value is left to fill", () => {
  const draft = draftFromEntry(entry([]), {
    kind: "pypi",
    identifier: "docs-mcp",
    version: "1.2",
    packageArgs: [],
    env: [
      input("LOG_LEVEL", { value: "info" }),
      input("TOKEN", { value: "{token}", secret: true }),
    ],
  });
  assert.deepEqual(
    draft.env.map((row) => [row.name, row.value]),
    [
      ["LOG_LEVEL", "info"],
      ["TOKEN", ""],
    ],
  );
  assert.equal(draft.registry, "pypi");
});

test("a remote option with URL variables and a Bearer header", () => {
  const draft = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://{tenant}.files.example.test/mcp",
    urlVariables: [
      {
        name: "tenant",
        description: "Tenant",
        required: true,
        secret: false,
        default: null,
        choices: [],
      },
    ],
    headers: [
      input("Authorization", { required: true, secret: true, value: "Bearer {token}" }),
    ],
  });
  assert.deepEqual(
    [draft.path, draft.transport, draft.url, draft.signIn],
    ["remote", "http", "", "headers"],
  );
  assert.equal(draft.urlTemplate.url, "https://{tenant}.files.example.test/mcp");
  assert.deepEqual(
    draft.headers.map(({ key, name, value, bearer }) => [key, name, value, bearer]),
    [["auth", "Authorization", "", true]],
  );
  assert.equal(
    composeUrl({ ...draft.urlTemplate, values: { tenant: "acme corp" } }),
    "https://acme%20corp.files.example.test/mcp",
  );
  fc.assert(
    fc.property(fc.string(), (value) => {
      const url = composeUrl({ ...draft.urlTemplate, values: { tenant: value } });
      assert.ok(!url.includes("{tenant}"));
    }),
  );
});

test("a remote option without variables keeps its address and has no template", () => {
  const draft = draftFromEntry(entry([]), {
    kind: "remote-sse",
    url: "https://docs.example.test/sse",
    urlVariables: [],
    headers: [],
  });
  assert.deepEqual(
    [draft.transport, draft.url, draft.urlTemplate, draft.signIn],
    ["sse", "https://docs.example.test/sse", null, "none"],
  );
});

test("unsupported options cannot be chosen", () => {
  assert.equal(isSelectable({ kind: "unsupported" }), false);
  assert.equal(isSelectable({ kind: "npm" }), true);
});
