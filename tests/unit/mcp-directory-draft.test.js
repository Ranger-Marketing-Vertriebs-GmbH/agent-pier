import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  composeUrl,
  composeValue,
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
  assert.equal(draft.env[1].template, undefined, "a bare {var} is the field itself");
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
      // A value may make the address invalid, but never point it somewhere else.
      if (!URL.canParse(url)) return;
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "https:");
      assert.ok(parsed.hostname.endsWith(".files.example.test"));
    }),
  );
});

const tokenVariable = {
  name: "key",
  description: "Your API key from the dashboard",
  required: true,
  secret: true,
  default: null,
  choices: [],
};

test("a header or env value with text around a template keeps that template", () => {
  const remote = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://docs.example.test/mcp",
    urlVariables: [],
    headers: [input("X-Api-Token", { value: "Token {key}", variables: [tokenVariable] })],
  });
  const [row] = remote.headers;
  assert.equal(row.value, "");
  assert.equal(row.bearer, undefined);
  assert.notEqual(row.key, "auth");
  assert.deepEqual(row.template, {
    value: "Token {key}",
    variables: [tokenVariable],
    values: {},
  });
  assert.equal(remote.hints.settings["X-Api-Token"].template, "Token {key}");
  assert.equal(
    composeValue({ ...row.template, values: { key: "a b/c" } }),
    "Token a b/c",
  );

  const userVariable = { ...tokenVariable, name: "user", secret: false };
  const pwVariable = { ...tokenVariable, name: "pw" };
  const pkg = draftFromEntry(entry([]), {
    kind: "npm",
    identifier: "pg-mcp",
    version: "1.0.0",
    packageArgs: [],
    env: [
      input("DATABASE_URL", {
        value: "postgres://{user}:{pw}@db/x",
        variables: [userVariable, pwVariable],
      }),
    ],
  });
  assert.deepEqual(pkg.env[0].template, {
    value: "postgres://{user}:{pw}@db/x",
    variables: [userVariable, pwVariable],
    values: {},
  });
  assert.equal(
    composeValue({ ...pkg.env[0].template, values: { user: "app", pw: "s3cret" } }),
    "postgres://app:s3cret@db/x",
  );
  assert.equal(composeValue({ value: "Basic {creds}" }), "Basic ");
});

test("only the first Bearer header is the sign-in row; the token hint falls back", () => {
  const draft = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://docs.example.test/mcp",
    urlVariables: [],
    headers: [
      input("Authorization", { value: "Bearer {key}", variables: [tokenVariable] }),
      input("X-Proxy-Authorization", { value: "Bearer {proxy}" }),
    ],
  });
  assert.deepEqual(
    draft.headers.map(({ key, bearer, template }) => [key, bearer, template]),
    [
      ["auth", true, undefined],
      ["directory-header-1", true, undefined],
    ],
  );
  assert.deepEqual(draft.hints.settings.Authorization, {
    description: "Your API key from the dashboard",
    required: true,
    secret: true,
  });
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
