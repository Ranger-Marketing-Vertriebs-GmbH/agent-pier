import test from "node:test";
import assert from "node:assert/strict";
import {
  requestReceipt,
  saveReceipt,
  replayReceipt,
} from "../../server/features/ssh/ssh-receipts.js";

function fixture() {
  const data = { receipts: [] };
  return {
    read: () => data,
    replacePart: (name, value) => {
      data[name] = value;
    },
  };
}
test("SSH receipt retries require identical input and retain only an input digest", () => {
  const catalog = fixture();
  const context = {
    projectId: "project",
    operation: "import",
    requestId: "request",
    input: { sourcePath: "/private/source", name: "key" },
  };
  const entry = { id: "key", projectId: "project", publicKey: "ssh-ed25519 fixture" };
  saveReceipt(catalog, context, entry);
  const receipt = requestReceipt(catalog, context);
  assert.equal(
    replayReceipt(receipt, () => ({ ...entry, name: "renamed" })).name,
    "renamed",
  );
  assert.equal(JSON.stringify(catalog.read()).includes("/private/source"), false);
  assert.throws(
    () => requestReceipt(catalog, { ...context, input: { name: "changed" } }),
    { code: "SSH_REQUEST_CONFLICT" },
  );
});
test("SSH receipt replay cannot expose a moved or deleted resource or a changed host", () => {
  const catalog = fixture();
  const context = {
    projectId: "one",
    operation: "register",
    requestId: "request",
    input: {},
  };
  const host = {
    id: "host",
    projectId: "one",
    host: "host.invalid",
    port: 22,
    username: "user",
    keyId: "key",
    hostKey: "pin",
  };
  saveReceipt(catalog, context, host);
  const receipt = requestReceipt(catalog, context);
  assert.throws(() => replayReceipt(receipt, () => ({ ...host, projectId: "two" })), {
    code: "SSH_REQUEST_RESOURCE_GONE",
  });
  assert.throws(
    () =>
      replayReceipt(receipt, () => {
        throw Error("missing");
      }),
    { code: "SSH_REQUEST_RESOURCE_GONE" },
  );
  assert.throws(() => replayReceipt(receipt, () => ({ ...host, hostKey: "changed" })), {
    code: "SSH_REQUEST_CONFLICT",
  });
  assert.throws(() => replayReceipt({ ...receipt, tombstone: true }, () => host), {
    code: "SSH_REQUEST_RESOURCE_GONE",
  });
});
