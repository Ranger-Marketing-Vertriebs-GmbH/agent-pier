# Network Remote Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AgentPier be reached over the operator's own network without Tailscale and without an extra proxy, protected by the existing workspace login, configurable from the settings page and from a headless script.

**Architecture:** One shared module owns the `network` block of `config.json` (validation, address detection, allowed host set, read/write). The single HTTP server binds to the configured address and `authorizeRequest` gains a third "network" branch. A new `/api/remote` route and a new `scripts/remote.mjs` both call the shared module; the settings page renders the result with an explicit plain-HTTP warning and a service restart button.

**Tech Stack:** Node.js 22+ ES modules, Express, React 18, node:test, Playwright, Prettier (90 columns, double quotes).

**Spec:** `docs/superpowers/specs/2026-09-14-network-remote-access-design.md`

## Global Constraints

- Source and test files stay at most 600 lines (`npm run check:structure`).
- Every browser-visible text exists in `web/lib/i18n/de/` and `web/lib/i18n/en/` with identical keys; reactive exports live in `web/lib/i18n/messages/`. Backend messages are German in `server/lib/i18n/de/`.
- No environment variable for the network mode; `config.json` is the only source. The file keeps mode `0600` (`writePrivate`).
- The Tailscale branch and the local branch of `authorizeRequest` keep their exact behaviour; `tailscale-*` headers are rejected in the network branch.
- Loopback stays reachable in every mode (health check, release activation).
- Warning text for plain HTTP is identical in the settings dialog and the script output (German), with an English equivalent in the web catalog.
- Commit messages in English with the prefixes `feat:`, `fix:`, `chore:`, `docs:`; end every commit message with the attribution lines the session reminder provides.
- Run `npx prettier --write <files>` before every commit; run `npm run check` before opening the PR. The test `isolated native and POSIX login shells …` in `tests/integration/shell.test.js` fails on this developer machine for environment reasons and is not a regression.

---

### Task 1: Shared network configuration module

**Files:**

- Create: `server/features/remote/network-access.js`
- Modify: `server/lib/config.js`
- Test: `tests/unit/network-access.test.js`

**Interfaces:**

- Produces:
  - `normalizeNetworkConfig(raw)` → `{ enabled: boolean, bind: string, hosts: string[] }`; throws `problem(message, 400)` on invalid input. `undefined`/`null` raw → `{ enabled: false, bind: "0.0.0.0", hosts: [] }`.
  - `detectNetworkAddresses({ interfaces = os.networkInterfaces, hostname = os.hostname } = {})` → `{ addresses: string[], hostname: string }` where `addresses` are non-internal IPv4 and IPv6 addresses (IPv6 without zone id) and `hostname` is the lower-cased machine name.
  - `allowedNetworkHosts(network, port, detected)` → `Set<string>` of `host:port` entries (IPv6 as `[addr]:port`) built from `detected.addresses`, `detected.hostname`, `${detected.hostname}.local` and `network.hosts`; returns an empty set when `network.enabled` is false.
  - `networkUrls(network, port, detected)` → `string[]` of `http://host:port` for the same set, deterministic order (list entries first, then hostname, then addresses).
  - `readNetworkConfig(dataDir)` → `{ port, remoteUrl, ownerLogin, network }` from `config.json` via `normalizeNetworkConfig`.
  - `writeNetworkConfig(dataDir, network)` → writes `config.json` preserving `port`, `remoteUrl`, `ownerLogin` and other keys, replacing only `network`.
  - `loadConfig()` now returns `network` (normalized) in addition to the existing fields.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/network-access.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeNetworkConfig,
  detectNetworkAddresses,
  allowedNetworkHosts,
  networkUrls,
  readNetworkConfig,
  writeNetworkConfig,
} from "../../server/features/remote/network-access.js";

test("missing network block is disabled with safe defaults", () => {
  assert.deepEqual(normalizeNetworkConfig(undefined), {
    enabled: false,
    bind: "0.0.0.0",
    hosts: [],
  });
});
test("network block validates bind and host entries", () => {
  assert.deepEqual(
    normalizeNetworkConfig({ enabled: true, bind: "::", hosts: ["Agentpier.Home.arpa"] }),
    { enabled: true, bind: "::", hosts: ["agentpier.home.arpa"] },
  );
  for (const bind of ["0.0.0.0/8", "example.com", "", 5, "127.0.0.1 "])
    assert.throws(() => normalizeNetworkConfig({ enabled: true, bind, hosts: [] }), {
      status: 400,
    });
  for (const host of ["http://a", "a/b", "a:4380", "bad host", "x".repeat(254), ""])
    assert.throws(() => normalizeNetworkConfig({ enabled: true, hosts: [host] }), {
      status: 400,
    });
  assert.throws(
    () => normalizeNetworkConfig({ enabled: true, hosts: Array(21).fill("a.example") }),
    { status: 400 },
  );
  assert.throws(() => normalizeNetworkConfig({ enabled: "yes" }), { status: 400 });
});
test("detected addresses exclude internal interfaces and zone ids", () => {
  const detected = detectNetworkAddresses({
    interfaces: () => ({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::1%en0", family: "IPv6", internal: false, scopeid: 4 },
        { address: "2001:db8::5", family: "IPv6", internal: false, scopeid: 0 },
      ],
    }),
    hostname: () => "MacMini",
  });
  assert.deepEqual(detected, {
    addresses: ["192.168.1.20", "2001:db8::5"],
    hostname: "macmini",
  });
});
test("allowed hosts combine list, host name and addresses with the port", () => {
  const network = { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] };
  const detected = { addresses: ["192.168.1.20", "2001:db8::5"], hostname: "macmini" };
  assert.deepEqual(
    [...allowedNetworkHosts(network, 4380, detected)],
    [
      "agentpier.home.arpa:4380",
      "macmini:4380",
      "macmini.local:4380",
      "192.168.1.20:4380",
      "[2001:db8::5]:4380",
    ],
  );
  assert.deepEqual(
    [...allowedNetworkHosts({ ...network, enabled: false }, 4380, detected)],
    [],
  );
  assert.deepEqual(networkUrls(network, 4380, detected), [
    "http://agentpier.home.arpa:4380",
    "http://macmini:4380",
    "http://macmini.local:4380",
    "http://192.168.1.20:4380",
    "http://[2001:db8::5]:4380",
  ]);
});
test("config file round trip keeps unrelated keys and private mode", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "network-config-"));
  try {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ port: 4390, remoteUrl: "https://x.ts.net", ownerLogin: "o@x" }),
    );
    assert.deepEqual(readNetworkConfig(dataDir).network, {
      enabled: false,
      bind: "0.0.0.0",
      hosts: [],
    });
    writeNetworkConfig(dataDir, { enabled: true, bind: "0.0.0.0", hosts: ["a.example"] });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.deepEqual(saved, {
      port: 4390,
      remoteUrl: "https://x.ts.net",
      ownerLogin: "o@x",
      network: { enabled: true, bind: "0.0.0.0", hosts: ["a.example"] },
    });
    assert.equal(fs.statSync(path.join(dataDir, "config.json")).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ network: 5 }));
    assert.throws(() => readNetworkConfig(dataDir), { status: 400 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/network-access.test.js`
Expected: FAIL with `Cannot find module '.../server/features/remote/network-access.js'`

- [ ] **Step 3: Implement the module**

```js
// server/features/remote/network-access.js
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const MAX_HOSTS = 20;
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const invalid = () => problem(serverMessages.settings.invalidNetworkConfig, 400);

/** Accepts the stored or submitted `network` block; missing means disabled. */
export function normalizeNetworkConfig(raw) {
  if (raw === undefined || raw === null)
    return { enabled: false, bind: "0.0.0.0", hosts: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid();
  const bind = raw.bind === undefined ? "0.0.0.0" : raw.bind;
  if (typeof bind !== "string" || net.isIP(bind) === 0) throw invalid();
  const hosts = raw.hosts === undefined ? [] : raw.hosts;
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) throw invalid();
  const normalized = hosts.map((host) => {
    if (typeof host !== "string") throw invalid();
    const value = host.toLowerCase();
    if (net.isIP(value) === 0 && !hostPattern.test(value)) throw invalid();
    return value;
  });
  return { enabled, bind, hosts: [...new Set(normalized)] };
}
/** Non-internal interface addresses and the lower-cased machine name. */
export function detectNetworkAddresses({
  interfaces = os.networkInterfaces,
  hostname = os.hostname,
} = {}) {
  const addresses = [];
  for (const entries of Object.values(interfaces()))
    for (const entry of entries || []) {
      if (entry.internal) continue;
      const address = entry.address.split("%")[0];
      if (entry.family === "IPv6" && address.startsWith("fe80:")) continue;
      if (!addresses.includes(address)) addresses.push(address);
    }
  return {
    addresses,
    hostname: hostname()
      .toLowerCase()
      .replace(/\.local$/, ""),
  };
}
const hostWithPort = (host, port) => `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
function candidates(network, detected) {
  if (!network.enabled) return [];
  const names = [
    ...network.hosts,
    detected.hostname,
    `${detected.hostname}.local`,
    ...detected.addresses,
  ];
  return [...new Set(names.filter(Boolean))];
}
/** Exact `Host` header values accepted by the network branch. */
export function allowedNetworkHosts(network, port, detected) {
  return new Set(candidates(network, detected).map((host) => hostWithPort(host, port)));
}
export function networkUrls(network, port, detected) {
  return candidates(network, detected).map(
    (host) => `http://${hostWithPort(host, port)}`,
  );
}
const file = (dataDir) => path.join(dataDir, "config.json");
export function readNetworkConfig(dataDir) {
  const saved = readJSON(file(dataDir), {});
  return { ...saved, network: normalizeNetworkConfig(saved.network) };
}
export function writeNetworkConfig(dataDir, network) {
  const saved = readJSON(file(dataDir), {});
  writePrivate(file(dataDir), { ...saved, network: normalizeNetworkConfig(network) });
}
```

Add to `server/lib/i18n/de/settings.js` (inside the exported object):

```js
  invalidNetworkConfig:
    "Ungültige Netzwerk-Konfiguration: Bind-Adresse muss eine IP sein, Hosts sind Namen oder IPs ohne Schema, Pfad oder Port (maximal 20).",
```

Modify `server/lib/config.js` so the returned object also carries `network`:

```js
import { normalizeNetworkConfig } from "../features/remote/network-access.js";
// inside loadConfig(), after `const saved = ...`:
  const network = normalizeNetworkConfig(saved.network);
// add to the returned object:
    network,
```

`normalizeNetworkConfig` throws a `problem` with a German message; `server/index.js` already lets startup errors surface, which satisfies "an invalid file aborts startup with a clear message".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/network-access.test.js tests/unit/runtime.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/remote/network-access.js server/lib/config.js server/lib/i18n/de/settings.js tests/unit/network-access.test.js
git add server/features/remote/network-access.js server/lib/config.js server/lib/i18n/de/settings.js tests/unit/network-access.test.js
git commit -m "feat: add shared network access configuration module"
```

---

### Task 2: Network branch in the host checks and login cookie

**Files:**

- Modify: `server/http/security.js:4-46`
- Modify: `server/features/mcp/http-transport.js:21-40`
- Modify: `server/http/login.js:31-47`
- Modify: `server/lib/i18n/de/http.js`
- Test: `tests/unit/security.test.js`, `tests/unit/mcp-transport-network.test.js`, `tests/unit/login-cookie-network.test.js`

**Interfaces:**

- Consumes: `config.network` from Task 1 and a new `config.networkHosts` (a `Set<string>` of `host:port`, produced in Task 3 by `effective()`; tests pass it directly).
- Produces: `authorizeRequest(req, config, websocket)` accepts non-loopback sources when `config.network.enabled` and `config.networkHosts.has(host)`; `authorizeMcpTransport` likewise; `cookieOptions(req, config)` exported from `login.js` returning `{ httpOnly, sameSite, secure, path }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/security.test.js`:

```js
const networkConfig = {
  ...config,
  network: { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] },
  networkHosts: new Set(["agentpier.home.arpa:4380", "192.168.1.20:4380"]),
};
const lan = (headers = {}, method = "GET", remoteAddress = "192.168.1.55") => ({
  headers: { host: "192.168.1.20:4380", ...headers },
  method,
  socket: { remoteAddress },
});
test("network branch accepts listed hosts from the LAN with matching origin", () => {
  assert.equal(authorizeRequest(lan(), networkConfig), true);
  assert.equal(
    authorizeRequest(lan({ origin: "http://192.168.1.20:4380" }, "POST"), networkConfig),
    true,
  );
  assert.equal(
    authorizeRequest(
      lan(
        { host: "agentpier.home.arpa:4380", origin: "http://agentpier.home.arpa:4380" },
        "POST",
      ),
      networkConfig,
    ),
    true,
  );
  assert.throws(
    () =>
      authorizeRequest(
        lan({ origin: "http://agentpier.home.arpa:4380" }, "POST"),
        networkConfig,
      ),
    { status: 403 },
  );
});
test("network branch ignores proxy headers but rejects Tailscale markers and unknown hosts", () => {
  assert.equal(
    authorizeRequest(
      lan({ "x-forwarded-for": "10.0.0.1", forwarded: "for=10.0.0.1" }),
      networkConfig,
    ),
    true,
  );
  assert.equal(authorizeRequest(lan({}, "GET", "127.0.0.1"), networkConfig), true);
  assert.throws(
    () => authorizeRequest(lan({ "tailscale-user-login": "x" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.throws(
    () => authorizeRequest(lan({ host: "evil.example:4380" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.throws(() => authorizeRequest(lan(), config), { status: 403 });
  assert.throws(
    () =>
      authorizeRequest(lan(), {
        ...networkConfig,
        network: { ...networkConfig.network, enabled: false },
      }),
    { status: 403 },
  );
});
test("local and Tailscale branches are unchanged by the network mode", () => {
  assert.equal(authorizeRequest(request(), networkConfig), true);
  assert.throws(
    () => authorizeRequest(request({ "x-forwarded-for": "1.1.1.1" }), networkConfig),
    {
      status: 403,
    },
  );
  assert.equal(
    authorizeRequest(
      request({
        host: "host.example.ts.net:8443",
        "tailscale-user-login": "owner@example.com",
      }),
      networkConfig,
    ),
    true,
  );
});
```

Create `tests/unit/mcp-transport-network.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { authorizeMcpTransport } from "../../server/features/mcp/http-transport.js";
const config = {
  port: 4380,
  remoteUrl: null,
  network: { enabled: true, bind: "0.0.0.0", hosts: [] },
  networkHosts: new Set(["192.168.1.20:4380"]),
};
const request = (headers = {}, remoteAddress = "192.168.1.55") => ({
  headers: { host: "192.168.1.20:4380", ...headers },
  method: "POST",
  path: "/mcp",
  socket: { remoteAddress },
});
test("MCP transport accepts listed network hosts and rejects others", () => {
  assert.equal(authorizeMcpTransport(request(), config), undefined);
  assert.throws(() => authorizeMcpTransport(request({ host: "10.0.0.9:4380" }), config), {
    status: 403,
  });
  assert.throws(
    () => authorizeMcpTransport(request({ "tailscale-user-login": "x" }), config),
    {
      status: 403,
    },
  );
  assert.throws(
    () =>
      authorizeMcpTransport(request(), {
        ...config,
        network: { ...config.network, enabled: false },
      }),
    { status: 403 },
  );
});
```

Create `tests/unit/login-cookie-network.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cookieOptions } from "../../server/http/login.js";
const config = {
  port: 4380,
  remoteUrl: "https://host.example.ts.net:8443",
  network: { enabled: true, bind: "0.0.0.0", hosts: [] },
  networkHosts: new Set(["192.168.1.20:4380"]),
};
const request = (host, remoteAddress, encrypted = false) => ({
  headers: { host },
  socket: { remoteAddress, encrypted },
});
test("cookies are Secure only for the HTTPS Tailscale host, never for plain network hosts", () => {
  assert.equal(
    cookieOptions(request("host.example.ts.net:8443", "127.0.0.1"), config).secure,
    true,
  );
  assert.equal(
    cookieOptions(request("192.168.1.20:4380", "192.168.1.55"), config).secure,
    false,
  );
  assert.equal(
    cookieOptions(request("127.0.0.1:4380", "127.0.0.1"), config).secure,
    false,
  );
  assert.equal(
    cookieOptions(request("192.168.1.20:4380", "192.168.1.55", true), config).secure,
    true,
  );
  assert.deepEqual(
    Object.keys(cookieOptions(request("127.0.0.1:4380", "127.0.0.1"), config)).sort(),
    ["httpOnly", "path", "sameSite", "secure"],
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/security.test.js tests/unit/mcp-transport-network.test.js tests/unit/login-cookie-network.test.js`
Expected: the three new security tests FAIL with 403 on the LAN requests; the MCP test FAILS with 403; the cookie test FAILS with `cookieOptions is not a function`.

- [ ] **Step 3: Implement the network branch**

In `server/http/security.js` replace the body of `authorizeRequest` from the `remoteAddress` check to the `else throw` with:

```js
const host = req.headers.host;
const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
  req.socket.remoteAddress,
);
const localHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
// The dev server is explicitly enabled by local configuration, never trusted in production.
for (const origin of config.devOrigins || []) localHosts.add(new URL(origin).host);
const headerNames = Object.keys(req.headers);
const proxyMarkers = headerNames.some(
  (key) =>
    key.startsWith("tailscale-") || key.startsWith("x-forwarded-") || key === "forwarded",
);
const tailscaleMarkers = headerNames.some((key) => key.startsWith("tailscale-"));
let expected;
if (loopback && localHosts.has(host)) {
  // Serve routes by TLS SNI and preserves Host: proxy markers must never enter the local trust branch.
  if (proxyMarkers) throw problem(serverMessages.http.proxyHostRequired, 403);
  expected = `http://${host}`;
} else if (loopback && config.remoteUrl && new URL(config.remoteUrl).host === host) {
  if (!config.ownerLogin || req.headers["tailscale-user-login"] !== config.ownerLogin)
    throw problem(serverMessages.http.tailscaleAccountDenied, 403);
  expected = new URL(config.remoteUrl).origin;
} else if (config.network?.enabled && config.networkHosts?.has(host)) {
  // Plain network access: the login protects the workspace; Tailscale markers never downgrade here.
  if (tailscaleMarkers) throw problem(serverMessages.http.proxyHostRequired, 403);
  expected = `http://${host}`;
} else if (!loopback) throw problem(serverMessages.http.networkHostNotAllowed, 403);
else throw problem(serverMessages.http.hostNotAllowed, 403);
```

Remove the earlier unconditional `remoteAddress` check (lines 8-9 in the current file); the `authorization` header check on line 6-7 stays first.

In `server/lib/i18n/de/http.js` add:

```js
  networkHostNotAllowed:
    "Netzwerkzugriff ist aus oder dieser Host ist nicht freigegeben. Einstellungen → Fernzugriff prüfen.",
```

In `server/features/mcp/http-transport.js` replace the start of `authorizeMcpTransport` up to `else throw problem("MCP host is not allowed.", 403);` with:

```js
const host = req.headers.host;
const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
  req.socket.remoteAddress,
);
const local = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
const headerNames = Object.keys(req.headers);
let expected;
if (loopback && local.has(host)) {
  if (
    headerNames.some(
      (key) =>
        key.startsWith("tailscale-") ||
        key.startsWith("x-forwarded-") ||
        key === "forwarded",
    )
  )
    throw problem("Proxy requests require the configured remote host.", 403);
  expected = `http://${host}`;
} else if (loopback && config.remoteUrl && new URL(config.remoteUrl).host === host)
  expected = new URL(config.remoteUrl).origin;
else if (config.network?.enabled && config.networkHosts?.has(host)) {
  if (headerNames.some((key) => key.startsWith("tailscale-")))
    throw problem("Proxy requests require the configured remote host.", 403);
  expected = `http://${host}`;
} else if (!loopback)
  throw problem("MCP requires the local, Tailscale or configured network host.", 403);
else throw problem("MCP host is not allowed.", 403);
```

In `server/http/login.js` export the cookie decision and use it:

```js
// Secure only when the transport is TLS or the request uses the HTTPS Tailscale host.
export function cookieOptions(req, config) {
  const tailscaleHost =
    config.remoteUrl?.startsWith("https://") &&
    new URL(config.remoteUrl).host === req.headers.host;
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: Boolean(req.socket.encrypted) || Boolean(tailscaleHost),
    path: "/",
  };
}
```

and inside `loginRoutes` replace the `cookie` helper body with:

```js
const cookie = (req, res, token) =>
  res.cookie(cookieName, token, {
    ...cookieOptions(req, effective()),
    maxAge: token ? sessionDuration : 0,
  });
```

Remove the now unused `remote`/`secure` locals. `directLocalRequest` stays unchanged, so network requests keep requiring login, including `/api/health`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/security.test.js tests/unit/mcp-transport-network.test.js tests/unit/login-cookie-network.test.js tests/integration/chat-attachments-route.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/http/security.js server/features/mcp/http-transport.js server/http/login.js server/lib/i18n/de/http.js tests/unit/security.test.js tests/unit/mcp-transport-network.test.js tests/unit/login-cookie-network.test.js
git add server/http/security.js server/features/mcp/http-transport.js server/http/login.js server/lib/i18n/de/http.js tests/unit/security.test.js tests/unit/mcp-transport-network.test.js tests/unit/login-cookie-network.test.js
git commit -m "feat: accept configured network hosts in the host checks"
```

---

### Task 3: Server binding and effective network state

**Files:**

- Modify: `server/index.js`
- Modify: `server/app.js:78-81` (`effective`)
- Modify: `server/lib/i18n/de/scripts.js`
- Test: `tests/integration/network-binding.test.js`

**Interfaces:**

- Consumes: `detectNetworkAddresses`, `allowedNetworkHosts`, `networkUrls` from Task 1.
- Produces: `createApplication(config)` computes `services.networkState = { detected, hosts: Set, urls: string[], bind: string }` once at startup and `effective()` returns `network`, `networkHosts` (the Set) alongside the existing fields; `server/index.js` listens on `config.network.enabled ? config.network.bind : "127.0.0.1"` and logs `serverMessages.scripts.serverListeningNetwork(urls)` when enabled.

- [ ] **Step 1: Write the failing integration test**

```js
// tests/integration/network-binding.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import { detectNetworkAddresses } from "../../server/features/remote/network-access.js";

async function start(t, network) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "network-binding-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const application = await createApplication({
    dataDir: path.join(root, "data"),
    home,
    port: 0,
    remoteUrl: null,
    ownerLogin: null,
    devOrigins: [],
    network,
  });
  await new Promise((resolve) =>
    application.server.listen(0, network.enabled ? network.bind : "127.0.0.1", resolve),
  );
  t.after(async () => {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { application, port: application.server.address().port };
}
test("network mode exposes the allowed hosts and answers a LAN request with the login page", async (t) => {
  const { application, port } = await start(t, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.test"],
  });
  const state = application.networkState;
  assert.equal(state.hosts.has(`agentpier.test:${port}`), true);
  assert.equal(state.urls[0], `http://agentpier.test:${port}`);
  const { addresses } = detectNetworkAddresses();
  const lan = addresses.find((address) => address.includes("."));
  if (!lan) {
    t.diagnostic("no non-loopback IPv4 address on this machine; skipping LAN request");
    return;
  }
  const response = await fetch(`http://${lan}:${port}/auth/status`, {
    headers: { host: `${lan}:${port}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
  const denied = await fetch(`http://${lan}:${port}/api/health`);
  assert.equal(denied.status, 401);
});
test("disabled network mode keeps every non-loopback host rejected", async (t) => {
  const { application, port } = await start(t, {
    enabled: false,
    bind: "0.0.0.0",
    hosts: [],
  });
  assert.equal(application.networkState.hosts.size, 0);
  const response = await fetch(`http://127.0.0.1:${port}/auth/status`, {
    headers: { host: `192.168.1.20:${port}` },
  });
  assert.equal(response.status, 403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/integration/network-binding.test.js`
Expected: FAIL with `Cannot read properties of undefined (reading 'hosts')` on `application.networkState` (`createApplication` returns `{ ...services, app, server, close }`).

- [ ] **Step 3: Implement the startup state and binding**

In `server/app.js` add the import and compute the state right before `effective` is defined (after `const instanceId = randomUUID();`):

```js
import {
  detectNetworkAddresses,
  allowedNetworkHosts,
  networkUrls,
} from "./features/remote/network-access.js";
```

```js
const network = config.network || { enabled: false, bind: "0.0.0.0", hosts: [] };
const detected = detectNetworkAddresses();
// Computed once per process; configuration changes apply after a restart.
services.networkState = {
  bind: network.enabled ? network.bind : "127.0.0.1",
  detected,
  hosts: new Set(),
  urls: [],
};
const effective = () => {
  const port = server.address()?.port || config.port;
  if (network.enabled && !services.networkState.hosts.size && server.address()) {
    services.networkState.hosts = allowedNetworkHosts(network, port, detected);
    services.networkState.urls = networkUrls(network, port, detected);
  }
  return { ...config, port, network, networkHosts: services.networkState.hosts };
};
server.once("listening", effective);
```

Because tests listen on port 0, the allowed set is filled on the first `listening`/`effective` call once the real port is known.

In `server/index.js` replace the `listen` call:

```js
const bind = config.network.enabled ? config.network.bind : "127.0.0.1";
application.server.listen(config.port, bind, () => {
  console.log(serverMessages.scripts.serverListening(config.port));
  if (config.network.enabled)
    console.log(
      serverMessages.scripts.serverListeningNetwork(application.networkState.urls),
    );
});
```

In `server/lib/i18n/de/scripts.js` add:

```js
  serverListeningNetwork: (urls) =>
    `Netzwerkzugriff aktiv ohne TLS. Erreichbar unter:\n${urls.map((url) => `  ${url}`).join("\n")}`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/network-binding.test.js tests/integration/api.test.js`
Expected: all PASS (the LAN request may be skipped with a diagnostic on machines without a LAN address).

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/app.js server/index.js server/lib/i18n/de/scripts.js tests/integration/network-binding.test.js
git add server/app.js server/index.js server/lib/i18n/de/scripts.js tests/integration/network-binding.test.js
git commit -m "feat: bind the web service to the configured network address"
```

---

### Task 4: Remote access API route with audit and restart

**Files:**

- Create: `server/http/routes/remote.js`
- Modify: `server/app.js:119-141` (mount)
- Modify: `server/lib/i18n/de/settings.js`
- Test: `tests/integration/remote-route.test.js`

**Interfaces:**

- Consumes: `readNetworkConfig`, `writeNetworkConfig`, `networkUrls` (Task 1); `services.networkState`, `effective()` (Task 3); `restartService` from `server/features/operations/release-service.js`; `services.audit.append`.
- Produces:
  - `GET /api/remote` → `{ local: { url }, tailscale: { url: string|null }, network: { saved: {enabled,bind,hosts}, running: {enabled,bind,hosts}, detected: {addresses,hostname}, urls: string[], restartRequired: boolean, locked: boolean } }` where `locked` is true when the current request arrived through the network branch (only `enabled: false` may be written then).
  - `PUT /api/remote` body `{ network: {enabled,bind,hosts} }` → same shape as GET after saving; 400 on invalid input; 403 when `locked` and the body changes anything other than `enabled: false`.
  - `POST /api/remote/restart` → `202 { restarting: true, instanceId }`, then schedules `restartService()` 300 ms after the response finished; a failure is written to `services.operationalWarnings` and to the audit log.
  - `remoteRoutes(services, { restart = restartService } = {})`.

- [ ] **Step 1: Write the failing integration test**

```js
// tests/integration/remote-route.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import { remoteRoutes } from "../../server/http/routes/remote.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-route-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const dataDir = path.join(root, "data");
  const restarts = [];
  const application = await createApplication({
    dataDir,
    home,
    port: 0,
    remoteUrl: "https://host.example.ts.net:8443",
    ownerLogin: "owner@example.com",
    devOrigins: [],
    network: { enabled: false, bind: "0.0.0.0", hosts: [] },
    remoteRestart: async () => restarts.push(Date.now()),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const port = application.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const setup = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ username: "owner", password: "correct horse battery" }),
  });
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const request = (method, url, body, headers = {}) =>
    fetch(`${base}${url}`, {
      method,
      headers: { cookie, origin: base, "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  t.after(async () => {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { application, dataDir, request, restarts, port };
}
test("remote settings read, validate, save and flag the restart", async (t) => {
  const f = await fixture(t);
  const initial = await (await f.request("GET", "/api/remote")).json();
  assert.equal(initial.local.url, `http://127.0.0.1:${f.port}`);
  assert.equal(initial.tailscale.url, "https://host.example.ts.net:8443");
  assert.deepEqual(initial.network.saved, { enabled: false, bind: "0.0.0.0", hosts: [] });
  assert.equal(initial.network.restartRequired, false);
  assert.equal(initial.network.locked, false);
  const invalid = await f.request("PUT", "/api/remote", {
    network: { enabled: true, hosts: ["a/b"] },
  });
  assert.equal(invalid.status, 400);
  const saved = await f.request("PUT", "/api/remote", {
    network: { enabled: true, bind: "0.0.0.0", hosts: ["Agentpier.Home.arpa"] },
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.network.saved, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.home.arpa"],
  });
  assert.equal(body.network.restartRequired, true);
  assert.equal(body.network.urls.includes(`http://agentpier.home.arpa:${f.port}`), true);
  const file = JSON.parse(await fs.readFile(path.join(f.dataDir, "config.json"), "utf8"));
  assert.deepEqual(file.network, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.home.arpa"],
  });
  const events = f.application.audit.list({ action: "setting.updated" }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].resourceId, "network-access");
  assert.equal(events[0].source, "user");
});
test("restart responds first and then calls the service adapter", async (t) => {
  const f = await fixture(t);
  const response = await f.request("POST", "/api/remote/restart");
  assert.equal(response.status, 202);
  assert.equal((await response.json()).restarting, true);
  assert.equal(f.restarts.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.restarts.length, 1);
});
```

The `locked` behaviour is covered in Task 3's LAN environment only when a LAN address exists; add this test that simulates the network branch by passing `networkHosts` through a fake request to the route's pure helper:

```js
import { remoteLocked } from "../../server/http/routes/remote.js";
test("requests through the network branch may only switch the mode off", () => {
  const config = {
    port: 4380,
    remoteUrl: null,
    network: { enabled: true, bind: "0.0.0.0", hosts: [] },
    networkHosts: new Set(["192.168.1.20:4380"]),
  };
  const lan = {
    headers: { host: "192.168.1.20:4380" },
    socket: { remoteAddress: "192.168.1.55" },
  };
  const local = {
    headers: { host: "127.0.0.1:4380" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(remoteLocked(lan, config), true);
  assert.equal(remoteLocked(local, config), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/integration/remote-route.test.js`
Expected: FAIL with `Cannot find module '.../server/http/routes/remote.js'`

- [ ] **Step 3: Implement the route**

```js
// server/http/routes/remote.js
import { Router } from "express";
import { isDeepStrictEqual } from "node:util";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import {
  normalizeNetworkConfig,
  readNetworkConfig,
  writeNetworkConfig,
  networkUrls,
} from "../../features/remote/network-access.js";
import { restartService } from "../../features/operations/release-service.js";

/** True when the request itself arrived through the plain network branch. */
export function remoteLocked(req, config) {
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
  const local = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const tailscale =
    config.remoteUrl && new URL(config.remoteUrl).host === req.headers.host;
  return !(loopback && (local.has(req.headers.host) || tailscale));
}
export function remoteRoutes(services, { restart = restartService } = {}) {
  const { config, audit, networkState } = services;
  const effective = services.effectiveConfig;
  const router = Router();
  const view = (req) => {
    const current = effective();
    const saved = readNetworkConfig(config.dataDir).network;
    const running = current.network;
    return {
      local: { url: `http://127.0.0.1:${current.port}` },
      tailscale: { url: current.remoteUrl || null },
      network: {
        saved,
        running,
        detected: networkState.detected,
        urls: networkUrls(saved, current.port, networkState.detected),
        restartRequired: !isDeepStrictEqual(saved, running),
        locked: remoteLocked(req, current),
      },
    };
  };
  router.get("/remote", (req, res) => res.json(view(req)));
  router.put("/remote", (req, res) => {
    const network = normalizeNetworkConfig(req.body?.network);
    const current = readNetworkConfig(config.dataDir).network;
    if (
      remoteLocked(req, effective()) &&
      !isDeepStrictEqual(network, { ...current, enabled: false })
    )
      throw problem(serverMessages.settings.networkLocked, 403);
    writeNetworkConfig(config.dataDir, network);
    audit?.append({
      action: "setting.updated",
      resourceType: "setting",
      resourceId: "network-access",
      outcome: "success",
      // The audit vocabulary allows only user, system and mcp: settings changes are "user".
      source: "user",
      details: { count: network.hosts.length },
    });
    res.json(view(req));
  });
  router.post("/remote/restart", (req, res) => {
    res.status(202).json({ restarting: true, instanceId: services.instanceId });
    res.once("finish", () =>
      setTimeout(async () => {
        try {
          await restart();
        } catch (error) {
          // Warning codes are short identifiers like the existing "event-storage".
          services.operationalWarnings.add("service-restart");
          audit?.append({
            action: "setting.failed",
            resourceType: "setting",
            resourceId: "network-access",
            outcome: "failure",
            source: "user",
          });
          services.onError?.(error);
        }
      }, 300),
    );
  });
  return router;
}
```

In `server/lib/i18n/de/settings.js` add:

```js
  networkLocked:
    "Über den Netzwerkzugriff kann der Netzwerkmodus nur ausgeschaltet werden. Bind-Adresse und Hostliste lokal oder über Tailscale ändern.",
  restartFailed:
    "Der Dienst konnte nicht neu gestartet werden. Bitte manuell neu starten: npm run service:install oder npm start.",
```

In `server/app.js`:

- expose `services.effectiveConfig = effective;` and `services.instanceId = instanceId;` right after `effective` is defined (Task 3 placed it there),
- import `remoteRoutes` and add `mount(remoteRoutes(services, config.remoteRestart ? { restart: config.remoteRestart } : {}));` next to the other `mount(...)` calls. `config.remoteRestart` is only supplied by tests.
- confirm `services.operationalWarnings` is the existing `Set` used by `/api/health` (it is, see `server/app.js:147`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/remote-route.test.js tests/integration/api.test.js tests/unit/i18n.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/http/routes/remote.js server/app.js server/lib/i18n/de/settings.js tests/integration/remote-route.test.js
git add server/http/routes/remote.js server/app.js server/lib/i18n/de/settings.js tests/integration/remote-route.test.js
git commit -m "feat: add remote access settings API with audit and restart"
```

---

### Task 5: Headless script `npm run remote`

**Files:**

- Create: `scripts/remote.mjs`
- Modify: `package.json` (scripts)
- Modify: `server/lib/i18n/de/scripts.js`
- Test: `tests/unit/remote-script.test.js`

**Interfaces:**

- Consumes: `readNetworkConfig`, `writeNetworkConfig`, `detectNetworkAddresses`, `networkUrls` (Task 1); `restartService`, `checkHealth` from `server/features/operations/release-service.js`; `AuditStore`.
- Produces: `runRemote({ argv, dataDir, log, restart, health, detect })` → exit code number; commands `status`, `enable`, `disable`, `hosts`; flags `--bind <ip>`, `--host <name>` (repeatable), `--add <name>`, `--remove <name>`, `--accept-plain-http`, `--no-restart`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/remote-script.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRemote, parseRemoteArguments } from "../../scripts/remote.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-script-"));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 4390 }));
  const lines = [],
    restarts = [];
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const run = (argv, options = {}) =>
    runRemote({
      argv,
      dataDir,
      log: (line) => lines.push(String(line)),
      restart: async () => restarts.push(argv[0]),
      health: async () => true,
      detect: () => ({ addresses: ["192.168.1.20"], hostname: "macmini" }),
      ...options,
    });
  const saved = () =>
    JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  return { run, lines, restarts, saved, dataDir };
}
test("argument parsing covers every command and flag", () => {
  assert.deepEqual(
    parseRemoteArguments([
      "enable",
      "--bind",
      "::",
      "--host",
      "a.example",
      "--host",
      "b.example",
      "--accept-plain-http",
      "--no-restart",
    ]),
    {
      command: "enable",
      bind: "::",
      hosts: ["a.example", "b.example"],
      add: [],
      remove: [],
      accept: true,
      restart: false,
    },
  );
  assert.deepEqual(
    parseRemoteArguments(["hosts", "--add", "c.example", "--remove", "a.example"]).add,
    ["c.example"],
  );
  assert.throws(() => parseRemoteArguments(["explode"]), /status|enable|disable|hosts/);
  assert.throws(() => parseRemoteArguments(["enable", "--bind"]), /--bind/);
});
test("enable requires the explicit plain-HTTP acceptance", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(["enable", "--host", "a.example"]), 2);
  assert.equal(f.saved().network, undefined);
  assert.equal(f.lines.join("\n").includes("--accept-plain-http"), true);
});
test("enable, hosts and disable write the configuration, restart and print URLs", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(["enable", "--host", "a.example", "--accept-plain-http"]), 0);
  assert.deepEqual(f.saved().network, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["a.example"],
  });
  assert.equal(f.saved().port, 4390);
  assert.equal(
    f.lines.some((line) => line.includes("http://a.example:4390")),
    true,
  );
  assert.equal(
    f.lines.some((line) => line.includes("http://192.168.1.20:4390")),
    true,
  );
  assert.deepEqual(f.restarts, ["enable"]);
  assert.equal(await f.run(["hosts", "--add", "b.example", "--remove", "a.example"]), 0);
  assert.deepEqual(f.saved().network.hosts, ["b.example"]);
  assert.equal(await f.run(["disable", "--no-restart"]), 0);
  assert.deepEqual(f.saved().network, {
    enabled: false,
    bind: "0.0.0.0",
    hosts: ["b.example"],
  });
  assert.deepEqual(f.restarts, ["enable", "hosts"]);
  assert.equal(await f.run(["status"]), 0);
  assert.equal(f.lines.at(-1).includes("b.example"), true);
});
test("a missing service prints the manual restart hint and a failed health check fails", async (t) => {
  const f = fixture(t);
  const code = await f.run(["enable", "--accept-plain-http"], {
    restart: async () => {
      throw Object.assign(new Error("not installed"), { status: 503 });
    },
  });
  assert.equal(code, 1);
  assert.equal(f.lines.join("\n").includes("service:install"), true);
  const failed = await f.run(["disable"], { health: async () => false });
  assert.equal(failed, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/remote-script.test.js`
Expected: FAIL with `Cannot find module '.../scripts/remote.mjs'`

- [ ] **Step 3: Implement the script**

```js
// scripts/remote.mjs
import { isMainModule } from "../server/lib/is-main-module.js";
import { serverMessages } from "../server/lib/i18n/de.js";
import { loadConfig } from "../server/lib/config.js";
import {
  detectNetworkAddresses,
  networkUrls,
  readNetworkConfig,
  writeNetworkConfig,
} from "../server/features/remote/network-access.js";
import {
  restartService,
  checkHealth,
} from "../server/features/operations/release-service.js";
import { AuditStore } from "../server/features/audit/audit-store.js";
import { applicationVersion } from "../server/features/operations/version.js";

const COMMANDS = ["status", "enable", "disable", "hosts"];
export function parseRemoteArguments(argv) {
  const [command = "status", ...rest] = argv;
  if (!COMMANDS.includes(command))
    throw new Error(serverMessages.scripts.remoteUsage(COMMANDS.join("|")));
  const result = {
    command,
    bind: "0.0.0.0",
    hosts: [],
    add: [],
    remove: [],
    accept: false,
    restart: true,
  };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(serverMessages.scripts.remoteFlagValueRequired(flag));
      index++;
      return next;
    };
    if (flag === "--bind") result.bind = value();
    else if (flag === "--host") result.hosts.push(value());
    else if (flag === "--add") result.add.push(value());
    else if (flag === "--remove") result.remove.push(value());
    else if (flag === "--accept-plain-http") result.accept = true;
    else if (flag === "--no-restart") result.restart = false;
    else throw new Error(serverMessages.scripts.remoteUsage(COMMANDS.join("|")));
  }
  return result;
}
function recordAudit(dataDir, outcome) {
  let audit;
  try {
    audit = new AuditStore({ dataDir });
    audit.append({
      action: outcome === "success" ? "setting.updated" : "setting.failed",
      resourceType: "setting",
      resourceId: "network-access",
      outcome,
      // The audit vocabulary allows only user, system and mcp: the headless script is "system".
      source: "system",
    });
  } catch {
  } finally {
    audit?.close();
  }
}
export async function runRemote({
  argv,
  dataDir,
  log = console.log,
  restart = restartService,
  health = checkHealth,
  detect = detectNetworkAddresses,
} = {}) {
  const options = parseRemoteArguments(argv);
  const config = readNetworkConfig(dataDir);
  const port = config.port || 4380;
  const detected = detect();
  const print = (network) => {
    log(serverMessages.scripts.remoteStatus(network.enabled, network.bind, dataDir));
    for (const url of networkUrls({ ...network, enabled: true }, port, detected))
      log(`  ${url}`);
    if (network.enabled) log(serverMessages.scripts.remotePlainHttpWarning);
  };
  if (options.command === "status") {
    print(config.network);
    return 0;
  }
  let network = config.network;
  if (options.command === "enable") {
    if (!options.accept) {
      log(serverMessages.scripts.remotePlainHttpWarning);
      log(serverMessages.scripts.remoteAcceptRequired);
      return 2;
    }
    network = {
      enabled: true,
      bind: options.bind,
      hosts: [...network.hosts, ...options.hosts],
    };
  } else if (options.command === "disable") network = { ...network, enabled: false };
  else
    network = {
      ...network,
      hosts: [
        ...network.hosts.filter((h) => !options.remove.includes(h.toLowerCase())),
        ...options.add,
      ],
    };
  try {
    writeNetworkConfig(dataDir, network);
  } catch (error) {
    recordAudit(dataDir, "failure");
    throw error;
  }
  recordAudit(dataDir, "success");
  print(readNetworkConfig(dataDir).network);
  if (!options.restart) {
    log(serverMessages.scripts.remoteRestartSkipped);
    return 0;
  }
  try {
    await restart();
  } catch {
    log(serverMessages.scripts.remoteServiceMissing);
    return 1;
  }
  const healthy = await health({ port, version: applicationVersion() });
  log(
    healthy
      ? serverMessages.scripts.remoteRestarted
      : serverMessages.scripts.remoteUnhealthy(port),
  );
  return healthy ? 0 : 1;
}
if (isMainModule(import.meta.url)) {
  const config = loadConfig();
  runRemote({ argv: process.argv.slice(2), dataDir: config.dataDir })
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
```

`applicationVersion` comes from `server/features/operations/version.js` (the same import `server/app.js` uses). If `checkHealth` compares `previousInstanceId`, pass `previousInstanceId: undefined` as above; it only requires a matching version and a string instance id.

Add to `server/lib/i18n/de/scripts.js`:

```js
  remoteUsage: (commands) =>
    `Verwendung: npm run remote -- <${commands}> [--bind <IP>] [--host <Name>]... [--add <Name>] [--remove <Name>] [--accept-plain-http] [--no-restart]`,
  remoteFlagValueRequired: (flag) => `${flag} benötigt einen Wert.`,
  remoteStatus: (enabled, bind, dataDir) =>
    `Netzwerkzugriff: ${enabled ? `aktiv auf ${bind}` : "aus"} · Datenverzeichnis ${dataDir}\nErreichbare Adressen bei aktivem Modus:`,
  remotePlainHttpWarning:
    "WARNUNG: Netzwerkzugriff ohne TLS. Passwort und Inhalte gehen unverschlüsselt durchs Netz. Keine Push-Benachrichtigungen und keine PWA-Installation. Nur in vertrauenswürdigen Netzen verwenden und keine Portweiterleitung ins Internet einrichten.",
  remoteAcceptRequired: "Zum Einschalten --accept-plain-http angeben.",
  remoteRestartSkipped: "Neustart übersprungen. Änderungen gelten nach dem nächsten Dienststart.",
  remoteServiceMissing:
    "Kein installierter Dienst gefunden. Neustart manuell mit npm run service:install oder npm start.",
  remoteRestarted: "Dienst neu gestartet und erreichbar.",
  remoteUnhealthy: (port) =>
    `Dienst antwortet nach dem Neustart nicht auf http://127.0.0.1:${port}/api/health. Bitte Dienststatus prüfen.`,
```

Add to `package.json` scripts: `"remote": "node scripts/remote.mjs",`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/remote-script.test.js tests/unit/runtime.test.js tests/integration/symlink-entrypoints.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write scripts/remote.mjs package.json server/lib/i18n/de/scripts.js tests/unit/remote-script.test.js
git add scripts/remote.mjs package.json server/lib/i18n/de/scripts.js tests/unit/remote-script.test.js
git commit -m "feat: add npm run remote for headless network access setup"
```

---

### Task 6: Settings page "Fernzugriff"

**Files:**

- Create: `web/features/remote/RemoteSettings.jsx`
- Create: `web/lib/i18n/de/remote.js`, `web/lib/i18n/en/remote.js`, `web/lib/i18n/messages/remote.js`
- Modify: `web/features/settings/SettingsPage.jsx`
- Modify: `web/lib/i18n/de/operations.js` and `web/lib/i18n/en/operations.js` (`sections`)
- Modify: `web/features/operations/routes.js` (`sections` allow-list)
- Modify: `web/features/operations/operations.css`
- Modify: `tests/browser/operations-fixture.js` (route `/remote`)
- Test: `tests/browser/remote-settings.spec.js`

**Interfaces:**

- Consumes: `GET /api/remote`, `PUT /api/remote`, `POST /api/remote/restart`, `GET /api/health` (Task 4). `useResource(path, { poll })`, `api(path, method, body)`, `useAsyncAction()`, `Modal`, `ErrorMessage` from `web/components/`.
- Produces: settings section id `remote` reachable at `/settings/remote`.

- [ ] **Step 1: Write the failing browser spec**

```js
// tests/browser/remote-settings.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`remote settings ${locale}`, () => {
    test.use({ locale });
    test("network mode needs confirmation, saves hosts and offers a restart", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings/remote");
      await expect(page.getByText(en ? "Local" : "Lokal", { exact: true })).toBeVisible();
      await expect(
        page.getByText("http://127.0.0.1:4380", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("https://host.example.ts.net:8443", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("switch", { name: en ? "Network access" : "Netzwerkzugriff" })
        .click();
      await expect(page.getByText(en ? /unencrypted/ : /unverschlüsselt/)).toBeVisible();
      await page
        .getByRole("button", { name: en ? "Enable anyway" : "Trotzdem einschalten" })
        .click();
      const input = page.getByRole("textbox", {
        name: en ? "Additional host" : "Zusätzlicher Host",
      });
      await input.fill("agentpier.home.arpa");
      await page
        .getByRole("button", { name: en ? "Add host" : "Host hinzufügen" })
        .click();
      await page.getByRole("button", { name: en ? "Save" : "Speichern" }).click();
      const put = state.calls
        .filter((c) => c.method === "PUT" && c.path === "/remote")
        .at(-1);
      expect(put.body).toEqual({
        network: { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.home.arpa"] },
      });
      await expect(
        page.getByText("http://agentpier.home.arpa:4380", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(en ? /Restart required/ : /Neustart erforderlich/),
      ).toBeVisible();
      await page
        .getByRole("button", { name: en ? "Restart service" : "Dienst neu starten" })
        .click();
      expect(
        state.calls.some((c) => c.method === "POST" && c.path === "/remote/restart"),
      ).toBe(true);
      await expect(
        page.getByText(en ? /Service restarted/ : /Dienst neu gestartet/),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    });
    test("network access itself may only switch the mode off", async ({ page }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.remote.network.locked = true;
      state.remote.network.saved.enabled = true;
      state.remote.network.running.enabled = true;
      await page.goto(baseURL + "/settings/remote");
      await expect(
        page.getByText(en ? /only be switched off/ : /nur ausgeschaltet/),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: en ? "Additional host" : "Zusätzlicher Host" }),
      ).toHaveCount(0);
      await page
        .getByRole("switch", { name: en ? "Network access" : "Netzwerkzugriff" })
        .click();
      await page.getByRole("button", { name: en ? "Save" : "Speichern" }).click();
      const put = state.calls
        .filter((c) => c.method === "PUT" && c.path === "/remote")
        .at(-1);
      expect(put.body.network.enabled).toBe(false);
    });
  });
}
```

Extend `tests/browser/operations-fixture.js`: add to the initial `state` object

```js
    remote: {
      local: { url: "http://127.0.0.1:4380" },
      tailscale: { url: "https://host.example.ts.net:8443" },
      network: {
        saved: { enabled: false, bind: "0.0.0.0", hosts: [] },
        running: { enabled: false, bind: "0.0.0.0", hosts: [] },
        detected: { addresses: ["192.168.1.20"], hostname: "macmini" },
        urls: [],
        restartRequired: false,
        locked: false,
      },
    },
    health: { application: "agentpier", version: "0.0.0-test", instanceId: "one", warnings: [] },
```

and in the routing chain before the final `else throw`:

```js
    else if (path === "/remote" && method === "GET") result = state.remote;
    else if (path === "/remote" && method === "PUT") {
      state.remote.network.saved = body.network;
      state.remote.network.restartRequired = true;
      state.remote.network.urls = [
        ...body.network.hosts.map((host) => `http://${host}:4380`),
        "http://macmini:4380",
        "http://macmini.local:4380",
        "http://192.168.1.20:4380",
      ];
      result = state.remote;
    } else if (path === "/remote/restart") {
      state.health = { ...state.health, instanceId: "two" };
      state.remote.network.running = state.remote.network.saved;
      state.remote.network.restartRequired = false;
      result = { restarting: true, instanceId: "one" };
    } else if (path === "/health") result = state.health;
```

Check how `calls` records `method`/`path`/`body` in that fixture (the existing native-requests spec uses `state.calls.filter((c) => c.path.endsWith("/answer")).at(-1).body`) and keep the same fields.

- [ ] **Step 2: Build and run the spec to verify it fails**

Run: `npm run build && AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/remote-settings.spec.js`
Expected: FAIL because the page shows no "Lokal"/"Local" card (section unknown).

- [ ] **Step 3: Implement copy, page and wiring**

`web/lib/i18n/de/remote.js`:

```js
export const remoteCopy = {
  title: "Fernzugriff",
  description: "Wie AgentPier von anderen Geräten erreichbar ist.",
  local: "Lokal",
  localDescription: "Immer aktiv. Nur auf diesem Rechner erreichbar.",
  tailscale: "Tailscale",
  tailscaleDescription:
    "Privates HTTPS im eigenen Tailnet, gebunden an das freigegebene Tailscale-Konto.",
  tailscaleOff: "Nicht eingerichtet. Auf dem Server: npm run tailscale",
  network: "Netzwerk",
  networkSwitch: "Netzwerkzugriff",
  networkDescription:
    "Ohne TLS unter der Adresse dieses Rechners erreichbar. Nur die Anmeldung schützt den Arbeitsbereich.",
  warningTitle: "Klartext-HTTP einschalten?",
  warning:
    "Passwort und Inhalte gehen unverschlüsselt durchs Netz. Keine Push-Benachrichtigungen und keine PWA-Installation. Nur in vertrauenswürdigen Netzen verwenden und keine Portweiterleitung ins Internet einrichten.",
  warningConfirm: "Trotzdem einschalten",
  warningCancel: "Abbrechen",
  activeWarning: "Netzwerkzugriff ohne TLS ist aktiv. Nur für vertrauenswürdige Netze.",
  bind: "Bind-Adresse",
  bindAll: "Alle Schnittstellen (0.0.0.0)",
  bindAllV6: "Alle Schnittstellen inkl. IPv6 (::)",
  hosts: "Zusätzliche Hosts",
  hostsDescription:
    "Namen oder IPs ohne Port, etwa ein eigener DNS-Name oder der Host eines Reverse-Proxys. Erkannte Adressen sind automatisch erlaubt.",
  hostInput: "Zusätzlicher Host",
  addHost: "Host hinzufügen",
  removeHost: (host) => `${host} entfernen`,
  urls: "Erreichbare Adressen",
  locked:
    "Über den Netzwerkzugriff kann der Modus nur ausgeschaltet werden. Bind-Adresse und Hostliste lokal oder über Tailscale ändern.",
  save: "Speichern",
  saved: "Gespeichert.",
  restartRequired: "Neustart erforderlich, damit die Änderung gilt.",
  restart: "Dienst neu starten",
  restarting: "Dienst startet neu …",
  restarted: "Dienst neu gestartet.",
  restartFailed:
    "Der Dienst hat sich nicht neu gemeldet. Manuell neu starten: npm run service:install oder npm start.",
  scriptHint: "Headless: npm run remote -- enable --accept-plain-http",
  loading: "Fernzugriff wird geladen …",
};
```

`web/lib/i18n/en/remote.js` with the same keys:

```js
export const remoteCopy = {
  title: "Remote access",
  description: "How AgentPier is reachable from other devices.",
  local: "Local",
  localDescription: "Always active. Reachable only on this machine.",
  tailscale: "Tailscale",
  tailscaleDescription:
    "Private HTTPS inside your tailnet, bound to the approved Tailscale account.",
  tailscaleOff: "Not configured. On the server: npm run tailscale",
  network: "Network",
  networkSwitch: "Network access",
  networkDescription:
    "Reachable without TLS at this machine's address. Only the login protects the workspace.",
  warningTitle: "Enable plain HTTP?",
  warning:
    "Password and content travel unencrypted through the network. No push notifications and no PWA installation. Use only in trusted networks and never forward the port to the internet.",
  warningConfirm: "Enable anyway",
  warningCancel: "Cancel",
  activeWarning: "Network access without TLS is active. Trusted networks only.",
  bind: "Bind address",
  bindAll: "All interfaces (0.0.0.0)",
  bindAllV6: "All interfaces incl. IPv6 (::)",
  hosts: "Additional hosts",
  hostsDescription:
    "Names or IPs without port, such as your own DNS name or the host of a reverse proxy. Detected addresses are allowed automatically.",
  hostInput: "Additional host",
  addHost: "Add host",
  removeHost: (host) => `Remove ${host}`,
  urls: "Reachable addresses",
  locked:
    "Through network access the mode can only be switched off. Change bind address and host list locally or through Tailscale.",
  save: "Save",
  saved: "Saved.",
  restartRequired: "Restart required for the change to apply.",
  restart: "Restart service",
  restarting: "Service is restarting …",
  restarted: "Service restarted.",
  restartFailed:
    "The service did not come back. Restart manually: npm run service:install or npm start.",
  scriptHint: "Headless: npm run remote -- enable --accept-plain-http",
  loading: "Loading remote access …",
};
```

`web/lib/i18n/messages/remote.js`:

```js
import * as de from "../de/remote.js";
import * as en from "../en/remote.js";
import { localizedCopy } from "../index.js";
export const remoteCopy = localizedCopy(de.remoteCopy, en.remoteCopy);
```

Add `remote: "Fernzugriff",` after `mcp` in `web/lib/i18n/de/operations.js` `sections` and `remote: "Remote access",` at the same position in `web/lib/i18n/en/operations.js`.

`web/features/remote/RemoteSettings.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { remoteCopy as copy } from "../../lib/i18n/messages/remote.js";

const RESTART_TIMEOUT = 25000;
export default function RemoteSettings() {
  const resource = useResource("/remote");
  const action = useAsyncAction();
  const [draft, setDraft] = useState(null);
  const [hostInput, setHostInput] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState(null);
  useEffect(() => {
    if (resource.data && !draft) setDraft(resource.data.network.saved);
  }, [resource.data, draft]);
  if (!resource.data || !draft)
    return <p role="status">{resource.error || copy.loading}</p>;
  const { local, tailscale, network } = resource.data;
  const locked = network.locked;
  const toggle = () => {
    if (!draft.enabled) setConfirm(true);
    else setDraft({ ...draft, enabled: false });
  };
  const addHost = () => {
    const host = hostInput.trim().toLowerCase();
    if (!host || draft.hosts.includes(host)) return;
    setDraft({ ...draft, hosts: [...draft.hosts, host] });
    setHostInput("");
  };
  const save = () =>
    action.run(async () => {
      const result = await api("/remote", "PUT", { network: draft });
      resource.update(result);
      setDraft(result.network.saved);
      setNotice(copy.saved);
    });
  const restartService = () =>
    action.run(async () => {
      const { instanceId } = await api("/remote/restart", "POST");
      setRestart("running");
      const deadline = Date.now() + RESTART_TIMEOUT;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const health = await api("/health");
          if (health.instanceId !== instanceId) {
            setRestart("done");
            resource.update(await api("/remote"));
            return;
          }
        } catch {}
      }
      setRestart("failed");
    });
  return (
    <section className="page operations-page remote-settings" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      <article className="settings-card">
        <h3>{copy.local}</h3>
        <p>{copy.localDescription}</p>
        <code>{local.url}</code>
      </article>
      <article className="settings-card">
        <h3>{copy.tailscale}</h3>
        <p>{copy.tailscaleDescription}</p>
        {tailscale.url ? <code>{tailscale.url}</code> : <p>{copy.tailscaleOff}</p>}
      </article>
      <article className="settings-card">
        <h3>{copy.network}</h3>
        <p>{copy.networkDescription}</p>
        <label className="switch-row">
          <input
            type="checkbox"
            role="switch"
            aria-label={copy.networkSwitch}
            checked={draft.enabled}
            onChange={toggle}
            disabled={action.busy}
          />
          {copy.networkSwitch}
        </label>
        {network.running.enabled && <p role="alert">{copy.activeWarning}</p>}
        {locked && <p role="status">{copy.locked}</p>}
        {!locked && (
          <>
            <label>
              {copy.bind}
              <select
                value={draft.bind}
                onChange={(event) => setDraft({ ...draft, bind: event.target.value })}
              >
                <option value="0.0.0.0">{copy.bindAll}</option>
                <option value="::">{copy.bindAllV6}</option>
                {network.detected.addresses.map((address) => (
                  <option key={address} value={address}>
                    {address}
                  </option>
                ))}
              </select>
            </label>
            <h4>{copy.hosts}</h4>
            <p>{copy.hostsDescription}</p>
            <ul className="chip-list">
              {draft.hosts.map((host) => (
                <li key={host}>
                  <span>{host}</span>
                  <button
                    type="button"
                    className="button secondary compact"
                    aria-label={copy.removeHost(host)}
                    onClick={() =>
                      setDraft({ ...draft, hosts: draft.hosts.filter((h) => h !== host) })
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="operations-form-row">
              <input
                type="text"
                aria-label={copy.hostInput}
                value={hostInput}
                onChange={(event) => setHostInput(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && (event.preventDefault(), addHost())
                }
              />
              <button type="button" className="button secondary" onClick={addHost}>
                {copy.addHost}
              </button>
            </div>
          </>
        )}
        {network.urls.length > 0 && (
          <>
            <h4>{copy.urls}</h4>
            <ul>
              {network.urls.map((url) => (
                <li key={url}>
                  <code>{url}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorMessage error={action.error} />
        {notice && <p role="status">{notice}</p>}
        {network.restartRequired && <p role="status">{copy.restartRequired}</p>}
        <div className="operations-actions">
          <button
            type="button"
            className="button primary"
            disabled={action.busy}
            onClick={save}
          >
            {copy.save}
          </button>
          {network.restartRequired && (
            <button
              type="button"
              className="button secondary"
              disabled={action.busy}
              onClick={restartService}
            >
              {copy.restart}
            </button>
          )}
        </div>
        {restart === "running" && <p role="status">{copy.restarting}</p>}
        {restart === "done" && <p role="status">{copy.restarted}</p>}
        {restart === "failed" && <p role="alert">{copy.restartFailed}</p>}
        <small>{copy.scriptHint}</small>
      </article>
      {confirm && (
        <Modal title={copy.warningTitle} close={() => setConfirm(false)}>
          <div className="operations-form">
            <p role="alert">{copy.warning}</p>
            <div className="operations-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirm(false)}
              >
                {copy.warningCancel}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setDraft({ ...draft, enabled: true });
                  setConfirm(false);
                }}
              >
                {copy.warningConfirm}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
```

In `web/features/settings/SettingsPage.jsx` add `const RemoteSettings = lazy(() => import("../remote/RemoteSettings.jsx"));` and a branch `section === "remote"` rendering `<Suspense fallback={<p role="status">{copy.loading}</p>}><RemoteSettings /></Suspense>` before the MCP branch.

`web/features/operations/routes.js` validates section names against a `sections` set near the top of the file (`readSettingsRoute` returns `{ view: "missing" }` for unknown names). Add `"remote"` to that set, otherwise `/settings/remote` renders the missing page.

The classes `settings-card`, `switch-row`, `chip-list` and `operations-form-row` do not exist yet: add them to `web/features/operations/operations.css` (card with the existing panel background and 1rem padding, `switch-row` as flex with 0.5rem gap, `chip-list` as flex-wrap list without bullets and 0.5rem gap, `operations-form-row` as flex with 0.5rem gap that wraps at phone width).

- [ ] **Step 4: Run the parity test, build and the browser spec**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js && npm run build && AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/remote-settings.spec.js tests/browser/settings.spec.js`
Expected: all PASS (if `tests/browser/settings.spec.js` does not exist, run only the new spec).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/remote/RemoteSettings.jsx web/features/settings/SettingsPage.jsx web/features/operations/routes.js web/lib/i18n/de/remote.js web/lib/i18n/en/remote.js web/lib/i18n/messages/remote.js web/lib/i18n/de/operations.js web/lib/i18n/en/operations.js web/features/operations/operations.css tests/browser/remote-settings.spec.js tests/browser/operations-fixture.js
git add web/features/remote web/features/settings/SettingsPage.jsx web/lib/i18n web/features/operations/operations.css web/features/operations/routes.js tests/browser/remote-settings.spec.js tests/browser/operations-fixture.js
git commit -m "feat: add remote access settings page with plain-HTTP warning"
```

---

### Task 7: Installation guide, cross-links and final verification

**Files:**

- Rewrite: `docs/remote-access.md`
- Modify: `docs/installation.md` (section 5), `docs/linux.md:46`, `README.md`, `README.de.md`
- Delete: `docs/superpowers/specs/2026-09-14-network-remote-access-design.md`, `docs/superpowers/plans/2026-09-14-network-remote-access.md`

- [ ] **Step 1: Rewrite `docs/remote-access.md` as the two-path guide**

Structure (write full prose, German like the surrounding docs, with the existing Tailscale content preserved in path A):

```markdown
# Fernzugriff einrichten

AgentPier lauscht standardmäßig nur auf Loopback. Für den Zugriff von anderen Geräten gibt es zwei gleichwertige Wege. Beide setzen die Anmeldung am Arbeitsbereich voraus (siehe login.md).

| | Weg A: Tailscale Serve | Weg B: Netzwerkmodus ohne Tailscale |
| Transport | HTTPS im Tailnet | Klartext-HTTP im eigenen Netz |
| Identität | Tailscale-Konto plus Anmeldung | nur Anmeldung |
| Push/PWA | ja | nein |
| Geeignet für | unterwegs, mehrere Netze | Heimnetz, LAN, eigener Reverse-Proxy |

## Weg A: Tailscale Serve

### Voraussetzungen

### Einrichten (npm run tailscale, npm run service:install, URL öffnen)

### Separate AgentPier-Identität (bestehender Abschnitt)

### Entfernen (tailscale serve --https=<Port> off)

## Weg B: Netzwerkmodus ohne Tailscale

### Was du akzeptierst (Warntext wörtlich: unverschlüsselt, keine Push/PWA, nur vertrauenswürdige Netze, keine Portweiterleitung)

### Einschalten über die Einstellungen (Einstellungen → Fernzugriff, Schalter, Bestätigung, Hosts, Speichern, Dienst neu starten)

### Einschalten per Skript (headless)

    npm run remote -- enable --accept-plain-http
    npm run remote -- enable --bind 0.0.0.0 --host agentpier.home.arpa --host macmini.local --accept-plain-http
    npm run remote -- hosts --add proxy.example.net
    npm run remote -- status
    npm run remote -- disable

### Hostliste: Beispiele (IP, .local-Name, eigener DNS-Name, Reverse-Proxy-Host mit Hinweis, dass der Proxy auf http://127.0.0.1:<Port> zeigt und X-Forwarded-Header ignoriert werden)

### Neustart und Prüfung (Skript startet Dienst neu und prüft /api/health; ohne Dienst npm start; Fehlerbild "Netzwerkzugriff ist aus oder dieser Host ist nicht freigegeben")

### Ausschalten

## Was die Anmeldung schützt und was nicht

- schützt: alle APIs, Terminal-WebSockets, statische Arbeitsbereichsdaten; Rate-Limit zehn Versuche pro Minute
- schützt nicht: Mitlesen im Netz bei Weg B, Geräte im selben Netz sehen die Anmeldeseite
- MCP: LAN-Clients erreichen den Endpunkt; die OAuth-Resource-URL bleibt Tailscale oder Loopback
```

- [ ] **Step 2: Replace section 5 in `docs/installation.md` and the link in `docs/linux.md`**

In `docs/installation.md` keep the heading `## 5. Optional: privater Fernzugriff` and replace the body with two sentences that name both paths and link to `remote-access.md#weg-a-tailscale-serve` and `remote-access.md#weg-b-netzwerkmodus-ohne-tailscale`; move the existing Tailscale commands into the guide. Keep the uninstall note about `tailscale serve --https=8443 off`.

In `docs/linux.md:46` change the sentence to: "Für dauerhaften Fernzugriff beschreibt die [Fernzugriffsanleitung](remote-access.md) Tailscale Serve und den Netzwerkmodus ohne Tailscale, der sich headless mit `npm run remote` einschalten lässt."

In `README.de.md:166` extend the sentence: "[Fernzugriff](docs/remote-access.md) erklärt Tailscale Serve, eine separate AgentPier-Identität und den Netzwerkmodus ohne Tailscale, der nur durch die Anmeldung geschützt ist." Apply the same change to the matching English sentence in `README.md` (search for `remote-access.md`).

- [ ] **Step 3: Remove the working documents and run the full check**

```bash
git rm docs/superpowers/specs/2026-09-14-network-remote-access-design.md docs/superpowers/plans/2026-09-14-network-remote-access.md
npx prettier --write docs/remote-access.md docs/installation.md docs/linux.md README.md README.de.md
npm run check
AGENTPIER_TEST_PORT=4391 npx playwright test
```

Expected: `npm run check` passes except the known `shell.test.js` POSIX login shell failure on this machine; every Playwright spec passes.

- [ ] **Step 4: Commit and open the pull request**

```bash
git add docs README.md README.de.md
git commit -m "docs: add the two-path remote access installation guide"
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push -u origin feat/network-remote-access
gh pr create --base main --head feat/network-remote-access --title "feat: network remote access without Tailscale" --body-file <(printf '%s\n' "## Problem" "..." )
```

Write the PR body in English: problem, behaviour (three trust branches, settings page, script, warning), validation (unit, integration, browser, `npm run check`), the documented limitations (no TLS, MCP resource URL), and the attribution footer from the session reminder.
