import test from "node:test";
import assert from "node:assert/strict";
import { hookAddresses } from "../../server/features/assistants/agent-hook-addresses.js";

const id = "3f1c2a9e-0000-4000-8000-000000000001";
const urls = ["http://192.168.1.20:4380", "http://box.local:4380"];

test("a hook has only its loopback address by default", () => {
  assert.deepEqual(hookAddresses({ config: { port: 4380 }, networkUrls: urls }, id), {
    local: `http://127.0.0.1:4380/hooks/${id}`,
    tailscale: null,
    network: [],
  });
});

test("Tailscale Serve adds the remote origin", () => {
  const config = { port: 4380, remoteUrl: "https://box.tail1.ts.net/some/path" };
  assert.equal(
    hookAddresses({ config, networkUrls: [] }, id).tailscale,
    `https://box.tail1.ts.net/hooks/${id}`,
  );
});

test("network addresses are listed only when network mode is on", () => {
  const off = { port: 4380, network: { enabled: false } };
  assert.deepEqual(hookAddresses({ config: off, networkUrls: urls }, id).network, []);
  const on = { port: 4380, network: { enabled: true } };
  assert.deepEqual(hookAddresses({ config: on, networkUrls: urls }, id).network, [
    `http://192.168.1.20:4380/hooks/${id}`,
    `http://box.local:4380/hooks/${id}`,
  ]);
});
