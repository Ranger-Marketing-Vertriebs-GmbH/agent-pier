import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesGuard } from "../../server/features/assistants/runtimes/hermes/tools/hermes-tool-guard.js";
import {
  cdpRefusal,
  cdpRefusals,
} from "../../server/features/assistants/runtimes/hermes/tools/hermes-cdp-policy.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-hosts.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";

// AGENTPIER-480: Hermes's browser_cdp sends any CDP command to the agent's Chromium.
// An agent without a shell must not reach host files or the browser's own settings
// through it: no file field filled from a host path, no download folder, no
// Browser.* beyond its version, no network resource loaded into the host's
// DevTools, no navigation to anything but a web page or about:blank.

function guardBridge(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cdp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = { id: "m1", runtime: "hermes", runtimeAgentId: "ap-m1" };
  const calls = [];
  const bridge = {
    assistants: { runtime: supervisor },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    browserPolicy: async (input) => {
      calls.push(input);
      return { allow: true };
    },
    callingChat: () => ({}),
  };
  return { bridge, calls };
}
const cdp = (method, params) => ({
  agentId: "ap-m1",
  sessionKey: "agent:ap-m1:hermes:s1",
  toolName: "browser_cdp",
  args: { method, ...(params && { params }) },
});

test("browser_cdp never reaches host files or the browser's own settings", async (t) => {
  const { bridge, calls } = guardBridge(t);
  for (const [method, params, reason] of [
    ["DOM.setFileInputFiles", { files: ["/etc/passwd"], nodeId: 1 }, "upload"],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp" }, "method"],
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/" }, "method"],
    ["Browser.close", {}, "method"],
    ["browser.grantPermissions", {}, "method"],
    ["Network.loadNetworkResource", { url: "file:///etc/passwd" }, "method"],
    ["Target.exposeDevToolsProtocol", { targetId: "T" }, "method"],
    ["Target.attachToBrowserTarget", {}, "method"],
    ["Security.setIgnoreCertificateErrors", { ignore: true }, "method"],
    ["Page.navigate", { url: "file:///etc/passwd" }, "address"],
    ["Page.navigate", { url: " FILE:///etc/passwd" }, "address"],
    ["Page.navigate", { url: "chrome://settings" }, "address"],
    ["Page.navigate", { url: "devtools://devtools/bundled/inspector.html" }, "address"],
    ["Page.navigate", { url: "javascript:alert(1)" }, "address"],
    ["Page.navigate", {}, "address"],
    ["Target.createTarget", { url: "file:///Users/" }, "address"],
    ["Target.createTarget", { url: "view-source:file:///etc/hosts" }, "address"],
  ]) {
    assert.equal(cdpRefusal({ method, params }), cdpRefusals[reason], method);
    assert.deepEqual(
      await hermesGuard(bridge, cdp(method, params)),
      { allow: false, message: cdpRefusals[reason] },
      method,
    );
  }
  // Nothing refused here reached AgentPier's browser limits (no Chromium started).
  assert.deepEqual(calls, []);
  for (const [method, params] of [
    ["Browser.getVersion", {}],
    ["Page.navigate", { url: "https://example.com/" }],
    ["Page.navigate", { url: "http://127.0.0.1:8080/" }],
    ["Target.createTarget", { url: "about:blank" }],
    ["Runtime.evaluate", { expression: "document.title" }],
    ["Page.captureScreenshot", {}],
  ])
    assert.equal(cdpRefusal({ method, params }), null, method);
  assert.deepEqual(
    await hermesGuard(bridge, cdp("Page.navigate", { url: "https://a.example/" })),
    { allow: true },
  );
  assert.equal(calls.at(-1).action, "cdp");
  // A method that is no string is refused as well.
  assert.equal(cdpRefusal({ method: 7 }), cdpRefusals.method);
});
