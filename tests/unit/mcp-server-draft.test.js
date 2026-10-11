import test from "node:test";
import assert from "node:assert/strict";
import {
  draftFrom,
  dropsStoredHeaders,
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

test("an OAuth create sends the scope and never the typed headers", () => {
  const draft = { ...draftFrom(null), name: "docs", url: " https://mcp.example.com " };
  draft.headers = [{ key: "n", name: "Authorization", value: "Bearer typed" }];
  draft.auth = "oauth";
  draft.oauthScope = "  read write ";
  assert.deepEqual(requestBody(draft, null), {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com",
    auth: "oauth",
    oauthScope: "read write",
  });
  assert.equal(dropsStoredHeaders(draft, null), false);
});

test("switching a header server to OAuth drops headers and is confirmed first", () => {
  const draft = draftFrom(http);
  draft.headers[0].value = "Bearer ignored";
  draft.auth = "oauth";
  assert.equal(dropsStoredHeaders(draft, http), true);
  assert.deepEqual(requestBody(draft, http), {
    revision: 4,
    auth: "oauth",
    oauthScope: "",
  });
  assert.equal(dropsStoredHeaders(draftFrom({ ...http, headerNames: [] }), http), false);
});

test("an OAuth server edit sends a changed scope and a switch back to headers", () => {
  const oauth = { ...http, headerNames: [], auth: "oauth", oauthScope: "read" };
  const draft = draftFrom(oauth);
  assert.equal(draft.auth, "oauth");
  assert.deepEqual(requestBody(draft, oauth), { revision: 4 });
  draft.oauthScope = "";
  assert.deepEqual(requestBody(draft, oauth), { revision: 4, oauthScope: "" });
  draft.auth = "headers";
  draft.headers = [{ key: "n", name: "Authorization", value: "Bearer t" }];
  assert.deepEqual(requestBody(draft, oauth), {
    revision: 4,
    auth: "headers",
    headers: { Authorization: "Bearer t" },
  });
});
