import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fc from "fast-check";
import {
  cursorOf,
  normaliseDetail,
  normaliseEntry,
  normaliseList,
} from "../../server/features/mcp-directory/normalise.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("an npm entry becomes an installable option with its settings", () => {
  const entry = normaliseEntry(fixture("opnsense"));
  assert.equal(entry.name, "io.github.example/opnsense-mcp-server");
  assert.equal(entry.namespace, "io.github.example");
  assert.equal(entry.title, "OPNsense");
  assert.equal(entry.status, "active");
  assert.equal(entry.publishedAt, "2025-10-01T10:00:00Z");
  assert.equal(entry.repositoryUrl, "https://github.com/example/opnsense-mcp-server");
  assert.equal(entry.installable, true);
  const [npm, oci] = entry.options;
  assert.equal(npm.kind, "npm");
  assert.deepEqual(
    [npm.identifier, npm.version, npm.transport],
    ["opnsense-mcp-server", "0.4.1", "stdio"],
  );
  assert.deepEqual(npm.packageArgs, ["--log-level", "info"]);
  assert.deepEqual(npm.ignored, ["runtimeHint"]);
  assert.deepEqual(
    npm.env.map(({ name, required, secret, format, default: value }) => [
      name,
      required,
      secret,
      format,
      value,
    ]),
    [
      ["OPNSENSE_URL", true, false, "string", null],
      ["OPNSENSE_API_KEY", true, true, "string", null],
      ["OPNSENSE_API_SECRET", true, true, "string", null],
      ["OPNSENSE_VERIFY_SSL", false, false, "boolean", "true"],
      ["OPNSENSE_ALLOW_WRITES", false, false, "boolean", "false"],
    ],
  );
  assert.deepEqual(
    [oci.kind, oci.unsupportedReason, oci.registryType],
    ["unsupported", "registryType", "oci"],
  );
  assert.equal(JSON.stringify(entry).includes("icon.png"), false);
  assert.equal(JSON.stringify(entry).includes("<b>"), false);
  assert.equal(JSON.stringify(entry).includes("futureField"), false);
});

test("remotes become HTTP or SSE options with URL and header variables", () => {
  const entry = normaliseEntry(fixture("remote-filesystem"));
  assert.equal(entry.publishedAt, "2025-11-01T00:00:00.123456Z");
  const [http, sse] = entry.options;
  assert.deepEqual(
    [http.kind, http.transport, http.url],
    ["remote-http", "http", "https://{tenant}.files.example.test/mcp"],
  );
  assert.deepEqual(http.urlVariables, [
    {
      name: "tenant",
      description: "Your tenant id",
      required: true,
      secret: false,
      default: null,
      choices: [],
    },
  ]);
  assert.equal(http.headers[0].name, "Authorization");
  assert.equal(http.headers[0].value, "Bearer {token}");
  assert.deepEqual(
    http.headers[0].variables.map((v) => [v.name, v.secret]),
    [["token", true]],
  );
  assert.deepEqual([sse.kind, sse.url], ["remote-sse", "https://files.example.test/sse"]);
  assert.equal(normaliseEntry(fixture("smithery-remote")).installable, true);
});

test("an undeclared template in a header value becomes a variable of that header", () => {
  // The live registry lists Smithery headers as "Bearer {smithery_api_key}" without
  // declaring the variable; the owner still fills it, as secret as its header.
  const [option] = normaliseEntry(fixture("smithery-remote")).options;
  assert.deepEqual(option.headers[0].variables, [
    {
      name: "smithery_api_key",
      description: "",
      required: true,
      secret: true,
      default: null,
      choices: [],
    },
  ]);
});

test("input names follow the server's rules and remote URLs carry no fragment", () => {
  const item = fixture("smithery-remote");
  const [remote] = item.server.remotes;
  remote.headers.push(
    { name: "Bad Header" },
    { name: "constructor" },
    { name: `X-${"a".repeat(100)}` },
  );
  assert.deepEqual(
    normaliseEntry(item).options[0].headers.map((header) => header.name),
    ["Authorization"],
  );
  remote.url = "https://server.smithery.ai/example/weather/mcp#frag";
  assert.deepEqual(
    [
      normaliseEntry(item).options[0].kind,
      normaliseEntry(item).options[0].unsupportedReason,
    ],
    ["unsupported", "url"],
  );
});

test("unsupported, deleted and deprecated entries", () => {
  const oci = normaliseEntry(fixture("oci-only"));
  assert.equal(oci.installable, false);
  assert.equal(normaliseEntry(fixture("deleted")), null);
  const old = normaliseEntry(fixture("deprecated"));
  assert.deepEqual(
    [old.status, old.statusMessage],
    ["deprecated", "Use ai.smithery/example-weather instead."],
  );
  assert.throws(
    () => normaliseDetail(fixture("deleted")),
    (error) => error.code === "MCP_DIRECTORY_NOT_FOUND",
  );
  assert.throws(
    () => normaliseDetail({ server: { name: 5 } }),
    (error) => error.code === "MCP_DIRECTORY_INVALID",
  );
});

test("oversize strings are cut and a required argument without value is unsupported", () => {
  const entry = normaliseEntry(fixture("oversize"));
  assert.equal(entry.title.length, 100);
  assert.ok(entry.title.endsWith("…"));
  assert.equal(entry.description.length, 300);
  assert.equal(entry.options[0].kind, "unsupported");
  assert.equal(entry.options[0].unsupportedReason, "argument");
  assert.ok(entry.options[0].env[0].description.length <= 500);
});

test("control and bidi characters are stripped; unsafe links and registries dropped", () => {
  const entry = normaliseEntry(fixture("bidi"));
  assert.equal(entry.title, "Safeexe.txt");
  assert.equal(entry.description, "lineone two");
  assert.equal(entry.repositoryUrl, null);
  assert.equal(entry.websiteUrl, null);
  assert.deepEqual(
    [entry.options[0].kind, entry.options[0].unsupportedReason],
    ["unsupported", "registryBaseUrl"],
  );
});

test("schema versions: known and later dates accepted, earlier refused", () => {
  const withSchema = (date) => {
    const item = fixture("smithery-remote");
    item.server.$schema = `https://static.modelcontextprotocol.io/schemas/${date}/server.schema.json`;
    return normaliseEntry(item);
  };
  for (const date of ["2025-09-16", "2025-09-29", "2025-12-11", "2026-07-01"])
    assert.ok(withSchema(date), date);
  assert.equal(withSchema("2025-07-09"), null);
});

test("lists drop invalid entries and pass back a safe cursor only", () => {
  const body = fixture("list");
  body.servers = [
    fixture("opnsense"),
    fixture("deleted"),
    { server: { name: "bad name" } },
    fixture("oci-only"),
  ];
  const { entries, nextCursor } = normaliseList(body);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["io.github.example/opnsense-mcp-server", "io.github.example/container-only"],
  );
  assert.equal(nextCursor, "io.github.example/opnsense-mcp-server:0.4.1");
  assert.equal(cursorOf("a b"), null);
  assert.equal(cursorOf("x".repeat(513)), null);
  assert.equal(cursorOf(42), null);
  assert.deepEqual(normaliseList({ nope: true }), { entries: [], nextCursor: null });
});

test("property: any input normalises without throwing and without control characters", () => {
  fc.assert(
    fc.property(fc.anything({ maxDepth: 4 }), (item) => {
      const entry = normaliseEntry(item);
      if (!entry) return;
      assert.doesNotMatch(JSON.stringify(entry), /[\u0000-\u001f‪-‮]/);
    }),
  );
  fc.assert(
    fc.property(
      fc.record({ title: fc.string(), description: fc.string({ maxLength: 2000 }) }),
      ({ title, description }) => {
        const item = fixture("smithery-remote");
        Object.assign(item.server, { title, description });
        const entry = normaliseEntry(item);
        assert.ok(entry.title.length <= 100 && entry.description.length <= 300);
      },
    ),
  );
});

test("remote URLs outside printable ASCII are refused, IDN hosts need punycode", () => {
  const reason = (url) => {
    const item = fixture("smithery-remote");
    item.server.remotes[0].url = url;
    const [option] = normaliseEntry(item).options;
    return [option.kind, option.unsupportedReason, option.url];
  };
  for (const url of [
    "https://ex.test/‮mcp",
    "https://ex.test/\u0085x",
    "https://аpple.com/mcp",
  ])
    assert.deepEqual(reason(url), ["unsupported", "url", null], JSON.stringify(url));
  assert.deepEqual(reason("https://xn--pple-43d.com/mcp"), [
    "remote-http",
    null,
    "https://xn--pple-43d.com/mcp",
  ]);
});

test("reserved templates and prototype keys never become variables or options", () => {
  const item = fixture("smithery-remote");
  const [remote] = item.server.remotes;
  remote.url = "https://{tenant}.example.test/mcp";
  remote.variables = JSON.parse(
    '{"__proto__":{"description":"polluted"},"tenant":{"description":"Tenant"}}',
  );
  remote.headers.push({ name: "X-Odd", value: "{__proto__} {constructor}" });
  const [option] = normaliseEntry(item).options;
  assert.deepEqual(
    option.urlVariables.map((v) => [v.name, v.description]),
    [["tenant", "Tenant"]],
  );
  assert.deepEqual(
    option.headers.map((header) => header.name),
    ["Authorization"],
  );
  remote.url = "https://ex.test/{__proto__}/mcp";
  assert.equal(normaliseEntry(item).options[0].unsupportedReason, "url");
  for (const type of ["toString", "constructor", "__proto__"]) {
    remote.type = type;
    assert.deepEqual(
      [
        normaliseEntry(item).options[0].kind,
        normaliseEntry(item).options[0].unsupportedReason,
      ],
      ["unsupported", "transport"],
      type,
    );
  }
});

test("an optional named argument without a value is left out, not passed bare", () => {
  const item = fixture("opnsense");
  item.server.packages[0].packageArguments.push(
    { type: "named", name: "--port" },
    { type: "positional", value: "serve" },
  );
  const [npm] = normaliseEntry(item).options;
  assert.equal(npm.kind, "npm");
  assert.deepEqual(npm.packageArgs, ["--log-level", "info", "serve"]);
});
