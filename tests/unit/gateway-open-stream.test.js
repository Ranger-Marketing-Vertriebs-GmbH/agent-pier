import test from "node:test";
import assert from "node:assert/strict";
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";

test("a screencast path never leaves the Gateway's own host", () => {
  const client = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/missing",
  });
  for (const path of [
    "/\\evil.example/x",
    "//evil.example/x",
    "https://evil.example/",
    "x",
  ])
    assert.throws(() => client.openStream(path), { code: "RPC_FAILED" }, path);
  // A path on the Gateway reaches the pinned connector (which has no pin here).
  assert.throws(() => client.openStream("/browser/screencast?token=a"), {
    code: "ENDPOINT_UNTRUSTED",
  });
});
