import test from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgent } from "../../scripts/service.mjs";
import { selectServePort } from "../../scripts/tailscale.mjs";
test("LaunchAgent encodes project paths and restarts only the app service", () => {
  const xml = renderLaunchAgent({
    projectDir: "/tmp/with & space",
    node: "/opt/node",
    dataDir: "/tmp/private",
    envPath: "/bin:/opt/bin",
  });
  assert.match(xml, /<string>\/tmp\/with &amp; space\/server\/index.js<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<string>dev.agentpier.server<\/string>/);
  assert.equal(xml.includes("kill-server"), false);
});
test("Tailscale provisioning preserves occupied ports and can reuse its exact owned endpoint", () => {
  assert.equal(selectServePort({}, 4380), 8443);
  const status = {
    TCP: { 8443: { HTTPS: true } },
    Web: { "host:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
  };
  assert.equal(selectServePort(status, 4380), 10000);
  assert.equal(
    selectServePort(
      {
        TCP: { 8443: { HTTPS: true } },
        Web: { "host:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4380" } } } },
      },
      4380,
    ),
    8443,
  );
  assert.throws(() => selectServePort({ TCP: { 8443: {}, 10000: {}, 9443: {} } }, 4380));
});

test("an explicit dedicated HTTPS port is used only when free or owned", () => {
  assert.equal(selectServePort({}, 4380, { httpsPort: 443 }), 443);
  assert.equal(
    selectServePort(
      {
        TCP: { 443: {} },
        Web: {
          "agentpier.example:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:4380" } },
          },
        },
      },
      4380,
      { httpsPort: 443 },
    ),
    443,
  );
  assert.throws(() => selectServePort({ TCP: { 443: {} } }, 4380, { httpsPort: 443 }));
  for (const httpsPort of [0, 65536, "443", NaN])
    assert.throws(() => selectServePort({}, 4380, { httpsPort }));
});
