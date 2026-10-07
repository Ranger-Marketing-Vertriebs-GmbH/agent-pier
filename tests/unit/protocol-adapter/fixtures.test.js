import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  collect,
  fixtureList,
  fromChunks,
  loadFixture,
  splitChunks,
} from "../../helpers/protocol-adapter.js";

const root = new URL("../../fixtures/protocol-adapter/", import.meta.url);
const clientDirs = ["clients/claude-code", "clients/codex"];
const upstreamDirs = ["upstreams/messages", "upstreams/responses", "upstreams/chat"];
const clientFiles = clientDirs.flatMap((dir) => fixtureList(dir));
const upstreamFiles = upstreamDirs.flatMap((dir) => fixtureList(dir));
const raw = (file) => fs.readFileSync(new URL(file, root), "utf8");

const forbidden = [
  /\/Users\//,
  /\/home\/(?!user\b)[a-z]/,
  /\/(?:private\/)?var\/folders\//,
  /-private-var-folders-/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-/,
  /\bBearer\s+(?!fixture\b)[A-Za-z0-9._-]{8,}/,
  /"(?:authorization|x-api-key|api-key|cookie|proxy-authorization)"\s*:/i,
  /\b(?!noreply@anthropic\.com\b)[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
];

test("every fixture directory has fixtures", () => {
  for (const dir of [...clientDirs, ...upstreamDirs])
    assert.ok(fixtureList(dir).length > 0, `${dir} is empty`);
});

test("client fixtures are recorded requests without credentials", () => {
  for (const file of clientFiles) {
    assert.match(file, /\.json$/, file);
    const fixture = loadFixture(file);
    assert.deepEqual(Object.keys(fixture).sort(), ["body", "headers", "path"], file);
    assert.match(fixture.path, /^\/v1\/(messages|responses)/, file);
    assert.equal(typeof fixture.body, "object", file);
    assert.equal(typeof fixture.headers, "object", file);
  }
});

test("upstream JSON fixtures are HTTP responses with status, headers and body", () => {
  for (const file of upstreamFiles.filter((name) => name.endsWith(".json"))) {
    const fixture = loadFixture(file);
    assert.deepEqual(Object.keys(fixture).sort(), ["body", "headers", "status"], file);
    assert.equal(Number.isInteger(fixture.status), true, file);
  }
});

test("upstream SSE fixtures are complete event blocks with JSON data", () => {
  const sseFiles = upstreamFiles.filter((name) => name.endsWith(".sse"));
  assert.ok(sseFiles.length > 0);
  for (const file of sseFiles) {
    const text = loadFixture(file);
    assert.equal(typeof text, "string", file);
    assert.ok(text.endsWith("\n\n"), `${file} must end with a blank line`);
    for (const block of text.trimEnd().split("\n\n")) {
      const lines = block.split("\n");
      for (const line of lines)
        assert.match(line, /^(event|data|id|retry)?:/, `${file}: ${line}`);
      for (const line of lines.filter((entry) => entry.startsWith("data:"))) {
        const data = line.slice(5).trim();
        if (data !== "[DONE]")
          assert.doesNotThrow(() => JSON.parse(data), `${file}: ${line}`);
      }
    }
  }
});

test("only .json and .sse fixtures exist", () => {
  for (const file of [...clientFiles, ...upstreamFiles])
    assert.match(file, /\.(json|sse)$/, file);
});

test("fixtures contain no secrets or personal paths", () => {
  for (const file of [...clientFiles, ...upstreamFiles, "README.md"]) {
    const text = raw(file);
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, file);
  }
});

test("splitChunks keeps every byte and appends the remainder", () => {
  assert.deepEqual(splitChunks("abcdefg", [2, 3]), ["ab", "cde", "fg"]);
  assert.deepEqual(splitChunks("abc", [5, 5]), ["abc"]);
  assert.deepEqual(splitChunks("abc", []), ["abc"]);
});

test("fromChunks and collect round-trip an async stream", async () => {
  assert.deepEqual(await collect(fromChunks(["a", "b"])), ["a", "b"]);
});
