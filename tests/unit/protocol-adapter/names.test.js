import test from "node:test";
import assert from "node:assert/strict";
import {
  createIdMap,
  createNameMap,
  fnv1a,
} from "../../../server/features/protocol-adapter/names.js";
import {
  decodeCarrier,
  encodeCarrier,
} from "../../../server/features/protocol-adapter/carrier.js";

const chat = () => createNameMap({ pattern: /^[a-zA-Z0-9_-]{1,64}$/, maxLength: 64 });
const messages = () =>
  createNameMap({ pattern: /^[a-zA-Z0-9_-]{1,128}$/, maxLength: 128 });

const LONG = "lookup_project_documentation_with_a_deliberately_long_tool_name";
const CODEX_NAMESPACE = "mcp__fixture";
const CLAUDE_MCP = `mcp__fixture__${LONG}`;

test("fnv1a is stable", () => {
  assert.equal(fnv1a(""), "811c9dc5");
  assert.equal(fnv1a("a"), "e40c292c");
});

test("valid short names pass through unchanged", () => {
  const map = chat();
  assert.equal(map.toUpstream("read_file"), "read_file");
  assert.deepEqual(map.fromUpstream("read_file"), { name: "read_file" });
});

test("short namespaced names are joined with a double underscore", () => {
  const map = chat();
  assert.equal(map.toUpstream("lookup", "mcp__fixture"), "mcp__fixture__lookup");
  assert.deepEqual(map.fromUpstream("mcp__fixture__lookup"), {
    name: "lookup",
    namespace: "mcp__fixture",
  });
});

test("the Codex fixture MCP tool fits Messages but is hashed for Chat", () => {
  const forChat = chat();
  const upstream = forChat.toUpstream(LONG, CODEX_NAMESPACE);
  assert.ok(upstream.length <= 64);
  assert.match(upstream, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.match(upstream, /^mcp__fixture__lookup_project_documentation_.*_[0-9a-f]{8}$/);
  assert.deepEqual(forChat.fromUpstream(upstream), {
    name: LONG,
    namespace: CODEX_NAMESPACE,
  });
  assert.equal(
    messages().toUpstream(LONG, CODEX_NAMESPACE),
    `${CODEX_NAMESPACE}__${LONG}`,
  );
});

test("a Claude Code MCP tool name maps to at most 64 characters and back", () => {
  assert.ok(CLAUDE_MCP.length > 64);
  const map = chat();
  const upstream = map.toUpstream(CLAUDE_MCP);
  assert.ok(upstream.length <= 64);
  assert.match(upstream, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(map.toUpstream(CLAUDE_MCP), upstream);
  assert.deepEqual(map.fromUpstream(upstream), { name: CLAUDE_MCP });
});

test("invalid characters and a fully invalid name still map to valid names", () => {
  const map = chat();
  for (const name of ["mcp.server:tool/x", "größe", "日本語"]) {
    const upstream = map.toUpstream(name);
    assert.match(upstream, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.deepEqual(map.fromUpstream(upstream), { name });
  }
});

test("collisions are resolved with a counter and stay reversible", () => {
  const map = createNameMap({ pattern: /^[a-z0-9_]{1,12}$/, maxLength: 12 });
  const hashed = map.toUpstream("a.b");
  // a later valid name that equals an allocated hashed name must not steal it
  const clash = map.toUpstream(hashed);
  assert.notEqual(clash, hashed);
  assert.deepEqual(map.fromUpstream(hashed), { name: "a.b" });
  assert.deepEqual(map.fromUpstream(clash), { name: hashed });
  // namespace boundary ambiguity
  const first = map.toUpstream("c", "a__b");
  const second = map.toUpstream("b__c", "a");
  assert.notEqual(first, second);
});

test("unknown upstream names come back verbatim", () => {
  assert.deepEqual(chat().fromUpstream("never_seen"), { name: "never_seen" });
});

test("id map keeps valid ids and hashes invalid ones", () => {
  const ids = createIdMap(/^[a-zA-Z0-9_-]+$/);
  assert.equal(ids.toUpstream("call_abc-1"), "call_abc-1");
  const odd = ids.toUpstream("fc:1/α");
  assert.match(odd, /^id_[0-9a-f]{8}$/);
  assert.equal(ids.toUpstream("fc:1/α"), odd);
  assert.equal(ids.fromUpstream(odd), "fc:1/α");
  assert.equal(ids.fromUpstream("call_abc-1"), "call_abc-1");
});

test("carrier round trips and reports no payload", () => {
  const carrier = encodeCarrier("codex", '{"a":"ü"}');
  assert.match(carrier, /^ap1\.codex\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCarrier(carrier), { origin: "codex", payload: '{"a":"ü"}' });
  assert.deepEqual(decodeCarrier(encodeCarrier("claude", null)), {
    origin: "claude",
    payload: null,
  });
  assert.deepEqual(decodeCarrier(encodeCarrier("claude", "")), {
    origin: "claude",
    payload: "",
  });
  assert.throws(() => encodeCarrier("bad.origin", "x"), RangeError);
});

test("real signatures and encrypted content are not carriers", () => {
  const anthropicSignature = `EqQBCkYIBxgCKkB${"Zm9vYmFy".repeat(40)}+/9a==`;
  const codexEncrypted = `gAAAAABp${"x1_-".repeat(50)}`;
  for (const value of [
    anthropicSignature,
    codexEncrypted,
    "",
    "ap1",
    "ap1.codex",
    "ap1.x.+",
  ]) {
    assert.equal(decodeCarrier(value), null);
  }
  assert.equal(decodeCarrier(undefined), null);
  assert.equal(decodeCarrier(42), null);
});

test("an empty namespace is the same as no namespace", () => {
  const map = createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 });
  const plain = map.toUpstream("read");
  assert.equal(map.toUpstream("read", ""), plain);
  assert.equal(map.toUpstream("read", null), plain);
  assert.deepEqual(map.fromUpstream(plain), { name: "read" });
  map.toUpstream("write", "");
  assert.deepEqual(map.fromUpstream("write"), { name: "write" });
});
