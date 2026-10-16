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
    fc.property(fc.string({ unit: "binary" }), (value) => {
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

test("unsupported options cannot be chosen or drafted", () => {
  assert.equal(isSelectable({ kind: "unsupported" }), false);
  assert.equal(isSelectable({ kind: "npm" }), true);
  for (const kind of ["unsupported", "docker", undefined]) {
    assert.throws(
      () => draftFromEntry(entry([]), { kind, url: null, headers: [], env: [] }),
      TypeError,
    );
  }
});

test("template names never read inherited object members", () => {
  for (const name of ["toString", "valueOf", "hasOwnProperty", "constructor"]) {
    assert.equal(
      composeUrl({ url: `https://x.test/{${name}}/mcp` }),
      "https://x.test//mcp",
    );
    assert.equal(composeValue({ value: `Token {${name}}`, values: {} }), "Token ");
  }
  assert.equal(
    composeValue({ value: "{n}", values: { n: 42 } }),
    "",
    "only strings fill",
  );
});

test("a lone surrogate in a URL value does not throw", () => {
  const url = composeUrl({ url: "https://x.test/{t}", values: { t: "a\uD800b" } });
  assert.equal(url, "https://x.test/a%EF%BF%BDb");
});

test("a bare {var} value takes its variable's hint metadata", () => {
  const tenant = {
    name: "tenant",
    description: "Tenant id",
    required: true,
    secret: true,
    default: "acme",
    choices: ["acme", "other"],
  };
  const remote = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://docs.example.test/mcp",
    urlVariables: [],
    headers: [input("X-Tenant", { value: "{tenant}", variables: [tenant] })],
  });
  assert.deepEqual(remote.hints.settings["X-Tenant"], {
    description: "Tenant id",
    required: true,
    secret: true,
    choices: ["acme", "other"],
    default: "acme",
  });
  const pkg = draftFromEntry(entry([]), {
    kind: "npm",
    identifier: "x",
    version: "1",
    packageArgs: [],
    env: [input("REGION", { value: "{region}", description: "Own text" })],
  });
  assert.deepEqual(pkg.hints.settings.REGION, {
    description: "Own text",
    required: false,
    secret: false,
  });
});

test("duplicate env names and case-variant header names keep the first row", () => {
  const remote = draftFromEntry(entry([]), {
    kind: "remote-http",
    url: "https://docs.example.test/mcp",
    urlVariables: [],
    headers: [
      input("X-Api-Key", { required: true, description: "first" }),
      input("x-api-key", { description: "second" }),
    ],
  });
  assert.deepEqual(
    remote.headers.map((row) => row.name),
    ["X-Api-Key"],
  );
  assert.equal(remote.hints.settings["X-Api-Key"].description, "first");
  assert.equal(remote.hints.settings["x-api-key"], undefined);
  const pkg = draftFromEntry(entry([]), {
    kind: "npm",
    identifier: "x",
    version: "1",
    packageArgs: [],
    env: [input("A", { value: "1" }), input("A", { value: "2" }), input("a")],
  });
  assert.deepEqual(
    pkg.env.map((row) => [row.name, row.value]),
    [
      ["A", "1"],
      ["a", ""],
    ],
  );
  assert.equal(pkg.hints.settings.toString, undefined);
});
