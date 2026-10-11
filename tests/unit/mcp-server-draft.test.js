import test from "node:test";
import assert from "node:assert/strict";
import {
  draftFrom,
  requestBody,
} from "../../web/features/mcp-servers/mcp-server-draft.js";

const http = {
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.com/v1",
  headerNames: ["Authorization", "X-Team"],
  envNames: [],
  revision: 4,
};

test("an unchanged edit sends only the revision and never the redacted address", () => {
  assert.deepEqual(requestBody(draftFrom(http), http), { revision: 4 });
});

test("stored entries are replaced or removed by name and never carry a value", () => {
  const draft = draftFrom(http);
  assert.ok(draft.headers.every((row) => row.stored && row.value === ""));
  draft.headers[0].value = "Bearer new";
  draft.headers[1].removed = true;
  draft.headers.push({ key: "n", name: "X-New", value: "1" });
  assert.deepEqual(requestBody(draft, http), {
    revision: 4,
    headers: { Authorization: "Bearer new", "X-Team": null, "X-New": "1" },
  });
});

test("a stdio create body splits arguments by line and omits empty fields", () => {
  const draft = { ...draftFrom(null), transport: "stdio", name: " local " };
  draft.command = " npx ";
  draft.args = "-y\n\nserver";
  assert.deepEqual(requestBody(draft, null), {
    name: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "server"],
  });
});
