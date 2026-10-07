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
import {
  createIdentifierScrubber,
  identifiersOf,
  isFixtureIdentifier,
} from "../../../scripts/dev/capture-cli-identifiers.mjs";

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

// The cases the README documents and the direction tests rely on.
const REQUIRED = {
  "clients/claude-code": [
    "image.json",
    "mcp-tool-result.json",
    "mcp.json",
    "text.json",
    "tool-call.json",
    "tool-result.json",
  ],
  "clients/codex": [
    "apply-patch-output.json",
    "apply-patch.json",
    "function-call-output.json",
    "function-call.json",
    "image.json",
    "mcp-output.json",
    "mcp.json",
    "reasoning-replay.json",
    "reasoning.json",
    "text.json",
    "web-search-disabled.json",
  ],
  "upstreams/messages": [
    "error-overloaded.sse",
    "max-tokens.sse",
    "non-stream.json",
    "overloaded.json",
    "parallel-tool-use.sse",
    "prompt-too-long.json",
    "rate-limit.json",
    "refusal.sse",
    "text.sse",
    "thinking-text.sse",
  ],
  "upstreams/responses": [
    "cached-usage.sse",
    "custom-tool-call.sse",
    "failed-context-length.sse",
    "function-calls.sse",
    "incomplete-max-output-tokens.sse",
    "reasoning-summary.sse",
    "text.sse",
  ],
  "upstreams/chat": [
    "context-azure-unverified.json",
    "context-litellm.json",
    "context-llamacpp.json",
    "context-lmstudio-unverified.json",
    "context-openai-unverified.json",
    "context-vllm.json",
    "length.sse",
    "parallel-tool-calls.sse",
    "reasoning-content.sse",
    "reasoning.sse",
    "text.sse",
    "think-inline.sse",
    "tool-call-whole.sse",
    "usage-cached.sse",
  ],
};

test("every directory holds its required cases, and IR snapshots mirror client fixtures", () => {
  for (const [dir, names] of Object.entries(REQUIRED)) {
    const present = fixtureList(dir).map((file) => file.split("/").pop());
    for (const name of names) assert.ok(present.includes(name), `${dir}/${name} missing`);
  }
  for (const dir of ["claude-code", "codex"]) {
    assert.deepEqual(
      fixtureList(`ir/${dir}`).map((file) => file.split("/").pop()),
      fixtureList(`clients/${dir}`).map((file) => file.split("/").pop()),
    );
  }
});

const sseData = (file) =>
  loadFixture(file)
    .trimEnd()
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
    });

test("Responses streams end in a terminal event with response.id and usage", () => {
  for (const file of fixtureList("upstreams/responses")) {
    const events = sseData(file);
    const last = events.at(-1);
    assert.match(last.event, /^response\.(completed|incomplete|failed)$/, file);
    assert.equal(last.data.type, last.event, file);
    assert.equal(typeof last.data.response.id, "string", file);
    assert.equal(events[0].event, "response.created", file);
    if (last.event !== "response.failed") {
      assert.equal(Number.isInteger(last.data.response.usage.input_tokens), true, file);
      assert.equal(Number.isInteger(last.data.response.usage.output_tokens), true, file);
    }
  }
});

test("Messages streams start with message_start and end with message_stop", () => {
  for (const file of fixtureList("upstreams/messages").filter((f) =>
    f.endsWith(".sse"),
  )) {
    const events = sseData(file);
    assert.equal(events[0].event, "message_start", file);
    const expected = file.endsWith("error-overloaded.sse") ? "error" : "message_stop";
    assert.equal(events.at(-1).event, expected, file);
    for (const { event, data } of events) assert.equal(data.type, event, file);
  }
});

test("Chat streams end with [DONE]", () => {
  for (const file of fixtureList("upstreams/chat").filter((f) => f.endsWith(".sse"))) {
    assert.equal(sseData(file).at(-1).data, "[DONE]", file);
  }
});

test("client fixtures carry only constant install and session identifiers", () => {
  let checked = 0;
  for (const file of clientFiles) {
    for (const [kind, value] of identifiersOf(loadFixture(file))) {
      checked += 1;
      assert.ok(isFixtureIdentifier(value), `${file}: ${kind} ${value}`);
    }
  }
  assert.ok(checked > 0);
});

test("the identifier scrubber keeps one session's ids equal across requests", () => {
  const scrubber = createIdentifierScrubber();
  const request = (session) => ({
    headers: { "x-claude-code-session-id": session },
    body: {
      metadata: {
        user_id: JSON.stringify({ device_id: "d".repeat(64), session_id: session }),
      },
    },
  });
  const first = scrubber.scrub(request("11111111-2222-4333-8444-555555555555"));
  const second = scrubber.scrub(request("11111111-2222-4333-8444-555555555555"));
  const other = scrubber.scrub(request("99999999-2222-4333-8444-555555555555"));
  assert.deepEqual(first, second);
  assert.equal(
    first.headers["x-claude-code-session-id"],
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    other.headers["x-claude-code-session-id"],
    "00000000-0000-4000-8000-000000000002",
  );
  assert.deepEqual(JSON.parse(first.body.metadata.user_id), {
    device_id: "fixture-device-id-1",
    session_id: "00000000-0000-4000-8000-000000000001",
  });
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
