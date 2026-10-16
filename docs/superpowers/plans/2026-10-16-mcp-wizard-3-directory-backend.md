# MCP Server Wizard – PR 3: MCP Registry Directory Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AgentPier a read-only, on-demand client for the official MCP Registry (`/v0.1`) that returns normalised, size-capped entries through `/api/mcp-directory/*`, behind an owner setting (on/off, base URL) in Settings → Workspace.

**Architecture:** `server/features/mcp-directory/` holds three pure-ish units – `normalise.js` (untrusted `server.json` → DTO), `cache.js` (in-memory LRU with TTL and negative entries) and `client.js` (downloads with origin pinning, size caps, a 10 s deadline, error mapping) – plus `directory-settings.js` for base-URL validation. `preferences.js` stores `mcpDirectory`; `server/http/routes/mcp-directory.js` exposes status, search and detail; nothing is fetched without an owner request and nothing is written anywhere.

**Tech Stack:** Node.js 22.13+ ES modules, Express, `fetch` + AgentPier's `download()` (`server/features/operations/release-download.js` via `releases.js`), `node:test`, fast-check, Playwright (settings row).

**Spec:** `docs/superpowers/specs/2026-10-16-mcp-wizard-design.md` – "Registry client (stage 2)": Endpoints, Cache, Settings, Untrusted data validation and size limits, Offline and errors, Never auto-install; "Security analysis" (SSRF, untrusted registry data, privacy); rollout stage 2a.

**Depends on:** PR 1 merged (uses `server/features/mcp-packages/publisher-info.js` `plainText`/`webLink`). Independent of PR 2. Branch `feat/mcp-directory-backend` from `origin/main`.

## Global Constraints

- Platform: macOS or Linux, Node.js 22.13+ (`AbortSignal.any`, `AbortSignal.timeout`). ES modules.
- Prettier: two-space indentation, double quotes, semicolons, trailing commas, 90 columns; `npm run format`, `npm run lint`.
- Files ≤ 600 lines (`npm run check:structure`).
- Registry endpoints (spec, verbatim): `GET <base>/v0.1/servers?search=<q>&limit=30&version=latest[&cursor=<c>]`, `GET <base>/v0.1/servers/<urlencoded name>/versions/latest`, `GET <base>/v0.1/health` (cached 5 min). Default `<base>` is `https://registry.modelcontextprotocol.io`.
- Browser endpoints: `GET /api/mcp-directory/status` → `{ enabled, host, reachable }`; `GET /api/mcp-directory/servers?search=&cursor=` → `{ entries, nextCursor }`; `GET /api/mcp-directory/servers/:name` → entry; all `Cache-Control: no-store`, login required like every `/api` route.
- Setting: `PATCH /preferences { mcpDirectory: { enabled, baseUrl } }`; `enabled` default `true`; `baseUrl` `https:` or `http:` on a loopback host only, no credentials, no query or fragment, ≤ 512 chars, stored without trailing slash. Disabled → `409 MCP_DIRECTORY_DISABLED`.
- Cache: in-memory LRU ≤ 200 entries keyed by normalised base URL + query (search lower-cased, trimmed, ≤ 100 chars; cursor) or by name; TTL 1 h for successes; failures not cached except a 60 s negative entry for 429/5xx; changing the setting clears it; no disk cache, prefetch or background refresh.
- Downloads: `pinOrigin: true`, `accept: application/json`, caps 2 MiB (list) and 512 KiB (detail), overall timeout 10 s, no cookies, no `Authorization`, proxy handling as for npm/PyPI, no retries.
- Validation (spec): unknown fields ignored; schema versions `2025-09-16`, `2025-09-29`, `2025-12-11` and later dates accepted; control and bidi characters stripped; caps name 200, title 100, description 300 (cut with "…"), statusMessage 300, env description 500, URLs 2048; links `https:`/`http:` only; `icons` and `_meta.publisher-provided` ignored; packages `npm`/`pypi` only with `registryBaseUrl` absent or exactly `https://registry.npmjs.org` / `https://pypi.org`; identifier passes `packageName()`; exact versions only; `runtimeHint`/`runtimeArguments` → `ignored[]`; secret or required-without-value arguments → option `unsupported`; env/header names pass the server's name rules, ≤ 100 each; `{var}` templates become `urlVariables`/header variables; `status: deleted` never shown; cursor passed back only if ≤ 512 printable chars.
- Errors: network failure, timeout, non-2xx, invalid JSON, oversize → `503 MCP_DIRECTORY_UNAVAILABLE`; detail 404 → `404 MCP_DIRECTORY_NOT_FOUND`; invalid detail → `502 MCP_DIRECTORY_INVALID`. Logged once with code and host, never with the search term.
- Never auto-install, never write directory data into CLI or agent configs.
- Backend messages in `server/lib/i18n/de/` and `server/lib/i18n/en/` (`mcp-directory.js`), registered in `catalog-de.js`/`catalog-en.js`; UI copy in `web/lib/i18n/{en,de}/mcp-directory.js` + `messages/`; parity tests pass.
- Tests: `node:test` strict, fast-check, loopback fake registry for integration (isolated, no internet), Playwright desktop + phone for the settings row.
- No change to `cli-reconciler.js`, `cli-bindings.js`, `program-select.js`, `mcp-packages.js`, `package-install-job.js`.
- Docs in the same PR (`docs/mcp.md`, the Settings → Workspace description where it lists rows). PR description lists docs checked; screenshots via `agent-pier-assets`.
- Commits in English with `feat:`/`fix:`/`chore:`/`docs:`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; linear history. Delete this plan before opening the PR; keep the spec and plan 4.

## Review Focus

1. **A base URL with a trailing slash or path** (`https://registry.example.test/mirror/`) must be stored without the trailing slash and keep its path, so `<base>/v0.1/servers` resolves under the path. Pinned in Task 1.
2. **The registry redirects a detail request to another host** (CDN, attacker). `pinOrigin` must refuse it with `503`, and the loopback path must refuse any redirect. Pinned in Task 4.
3. **Search terms with mixed case and spaces** (`"  GitHub "`) hit the same cache entry as `"github"`; a different base URL never shares entries. Pinned in Task 3.
4. **A server name with a slash and dots** (`io.github.user/my-server`) must be URL-encoded as one path segment towards the registry and accepted on `/api/mcp-directory/servers/:name` (Express decodes `%2F`). Pinned in Task 5.
5. **The setting is switched off while a search is in flight** – the response may still arrive, but the next request answers `409` and the cache is empty. Pinned in Task 5.

## File Structure

Create:

| File                                                                                                                                          | Responsibility                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `server/features/mcp-directory/directory-settings.js`                                                                                         | `defaultBaseUrl`, `normaliseBaseUrl()`, `directorySettings(saved)`.                       |
| `server/features/mcp-directory/normalise.js`                                                                                                  | `normaliseEntry()`, `normaliseList()`, `normaliseDetail()`, option and input normalisers. |
| `server/features/mcp-directory/cache.js`                                                                                                      | `TtlCache` (LRU, TTL, clock injection).                                                   |
| `server/features/mcp-directory/directory-errors.js`                                                                                           | `directoryProblem(code)` with stable codes.                                               |
| `server/features/mcp-directory/client.js`                                                                                                     | `McpDirectory` – status, search, detail, clear; downloads and error mapping.              |
| `server/http/routes/mcp-directory.js`                                                                                                         | The three browser routes.                                                                 |
| `server/lib/i18n/{de,en}/mcp-directory.js`                                                                                                    | Backend messages.                                                                         |
| `web/lib/i18n/{en,de}/mcp-directory.js`, `web/lib/i18n/messages/mcp-directory.js`                                                             | Settings row copy (and PR 4's directory UI copy).                                         |
| `web/features/settings/McpDirectoryRow.jsx`                                                                                                   | Settings → Workspace row (switch + base URL behind Advanced).                             |
| `tests/fixtures/mcp-registry/*.json`                                                                                                          | Trimmed registry-shaped entries.                                                          |
| `tests/unit/mcp-directory-settings.test.js`, `mcp-directory-normalise.test.js`, `mcp-directory-cache.test.js`, `mcp-directory-client.test.js` | Unit tests.                                                                               |
| `tests/integration/mcp-directory-routes.test.js`, `tests/helpers/fake-mcp-registry.js`                                                        | Loopback fake registry and route tests.                                                   |
| `tests/browser/mcp-directory-settings.spec.js`                                                                                                | Settings row.                                                                             |

Modify: `server/features/settings/preferences.js`, `server/http/routes/workspace.js` (clear cache on change), `server/http/responses.js` (emit `MCP_DIRECTORY_*` codes), `server/application/services.js`, `server/app.js`, `server/lib/i18n/catalog-de.js`, `catalog-en.js`, `web/features/settings/WorkspaceTab.jsx`, `web/features/settings/settings-steps.js` (`preferenceKeys`), `tests/integration/preferences.test.js` (and other exact `get()` expectations), `docs/mcp.md`.

## Parallel Groups

- **First:** Task 6 (message catalogs and error helper; Tasks 1 and 4 import its messages).
- **Group A (after 6, parallel):** Tasks 1, 2, 3.
- **Task 4** after 1, 2, 3.
- **Group B (after 4, parallel):** Task 5 (routes + wiring + preferences) and Task 7 (Settings row – it needs only the preferences shape from Task 5's interface; run it after Task 5 if you prefer one working tree).
- **Task 8** last.

---

### Task 1: Base URL rules

**Files:**

- Create: `server/features/mcp-directory/directory-settings.js`
- Test: `tests/unit/mcp-directory-settings.test.js`

**Interfaces:**

- Produces: `defaultBaseUrl = "https://registry.modelcontextprotocol.io"`; `normaliseBaseUrl(value) → string` (throws an error with `code: "MCP_DIRECTORY_INVALID_SETTINGS"`); `isLoopbackHost(hostname) → boolean`; `directorySettings(saved) → { enabled: boolean, baseUrl: string }` (invalid saved values fall back to the defaults).

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  defaultBaseUrl,
  directorySettings,
  isLoopbackHost,
  normaliseBaseUrl,
} from "../../server/features/mcp-directory/directory-settings.js";

test("https bases are stored without a trailing slash and keep their path", () => {
  assert.equal(
    normaliseBaseUrl("https://registry.example.test/"),
    "https://registry.example.test",
  );
  assert.equal(
    normaliseBaseUrl(" https://registry.example.test/mirror/ "),
    "https://registry.example.test/mirror",
  );
  assert.equal(
    normaliseBaseUrl("HTTPS://Registry.Example.Test"),
    "https://registry.example.test",
  );
});

test("plain http is allowed on loopback hosts only", () => {
  assert.equal(normaliseBaseUrl("http://127.0.0.1:8123"), "http://127.0.0.1:8123");
  assert.equal(normaliseBaseUrl("http://localhost:8123/"), "http://localhost:8123");
  assert.equal(normaliseBaseUrl("http://[::1]:8123"), "http://[::1]:8123");
  for (const host of ["localhost", "127.0.0.1", "127.8.9.1", "[::1]"])
    assert.equal(isLoopbackHost(host), true);
  for (const host of ["example.test", "10.0.0.1", "0.0.0.0", "localhost.example.test"])
    assert.equal(isLoopbackHost(host), false, host);
});

test("credentials, queries, fragments, other schemes and long values are refused", () => {
  for (const value of [
    "http://registry.example.test",
    "https://user:pw@registry.example.test",
    "https://registry.example.test/?x=1",
    "https://registry.example.test/?",
    "https://registry.example.test/#x",
    "ftp://registry.example.test",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "",
    "registry.example.test",
    `https://example.test/${"a".repeat(520)}`,
    42,
    null,
  ])
    assert.throws(
      () => normaliseBaseUrl(value),
      (error) => error.code === "MCP_DIRECTORY_INVALID_SETTINGS",
      String(value),
    );
});

test("saved settings fall back to defaults when unreadable", () => {
  assert.deepEqual(directorySettings(undefined), {
    enabled: true,
    baseUrl: defaultBaseUrl,
  });
  assert.deepEqual(directorySettings({ enabled: false }), {
    enabled: false,
    baseUrl: defaultBaseUrl,
  });
  assert.deepEqual(directorySettings({ enabled: "no", baseUrl: "ftp://x" }), {
    enabled: true,
    baseUrl: defaultBaseUrl,
  });
  fc.assert(
    fc.property(fc.anything(), (saved) => {
      const settings = directorySettings(saved);
      assert.equal(typeof settings.enabled, "boolean");
      assert.doesNotThrow(() => normaliseBaseUrl(settings.baseUrl));
    }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-directory-settings.test.js`
Expected: FAIL – module not found.

- [ ] **Step 3: Implement**

`server/features/mcp-directory/directory-settings.js`:

```js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// The owner's MCP directory setting. The base URL is the only address AgentPier sends
// search terms to, so it is held to https (http only on this computer).
export const defaultBaseUrl = "https://registry.modelcontextprotocol.io";
const limit = 512;

const invalid = () =>
  Object.assign(problem(serverMessages.mcpDirectory.invalidSettings, 400), {
    code: "MCP_DIRECTORY_INVALID_SETTINGS",
  });

export const isLoopbackHost = (hostname) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

export function normaliseBaseUrl(value) {
  if (typeof value !== "string") throw invalid();
  const text = value.trim();
  if (!text || text.length > limit || /[?#]/.test(text)) throw invalid();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (url.username || url.password) throw invalid();
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!secure && !local) throw invalid();
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The stored setting, or the defaults for anything that does not validate. */
export function directorySettings(saved) {
  const record = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  let baseUrl = defaultBaseUrl;
  try {
    if (record.baseUrl !== undefined) baseUrl = normaliseBaseUrl(record.baseUrl);
  } catch {
    baseUrl = defaultBaseUrl;
  }
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    baseUrl,
  };
}
```

This uses `serverMessages.mcpDirectory.invalidSettings` from Task 6, which runs first.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-settings.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-directory/directory-settings.js tests/unit/mcp-directory-settings.test.js
git commit -m "feat: validate the MCP directory base URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Normalising registry entries

**Files:**

- Create: `server/features/mcp-directory/normalise.js`, `tests/fixtures/mcp-registry/opnsense.json`, `remote-filesystem.json`, `smithery-remote.json`, `oci-only.json`, `deleted.json`, `deprecated.json`, `oversize.json`, `bidi.json`, `list.json`
- Test: `tests/unit/mcp-directory-normalise.test.js`

**Interfaces:**

- Consumes: `plainText(value, cap)`, `webLink(value)` (`server/features/mcp-packages/publisher-info.js`, PR 1); `packageRef({ registry, name, version })` (`package-spec.js`).
- Produces:
  - `Entry = { name, title, description, version, namespace, status: "active"|"deprecated", statusMessage, publishedAt: string|null, repositoryUrl: string|null, websiteUrl: string|null, options: Option[], installable: boolean }`.
  - `Option = { kind: "npm"|"pypi"|"remote-http"|"remote-sse"|"unsupported", identifier, version, transport: "stdio"|"http"|"sse"|string, url: string|null, urlVariables: Variable[], env: Input[], headers: Input[], packageArgs: string[], ignored: string[], unsupportedReason: null|"registryType"|"registryBaseUrl"|"identifier"|"version"|"transport"|"argument"|"url", registryType? }`.
  - `Input = { name, description, required, secret, format, default, choices: string[], value: string|null, variables: Variable[] }`; `Variable = { name, description, required, secret, default, choices }`.
  - `normaliseEntry(item) → Entry|null` (null for invalid or deleted), `normaliseList(body) → { entries, nextCursor }`, `normaliseDetail(body) → Entry` (throws `{ code: "MCP_DIRECTORY_NOT_FOUND" }` for deleted, `{ code: "MCP_DIRECTORY_INVALID" }` otherwise), `cursorOf(value) → string|null`.

- [ ] **Step 1: Capture and trim the fixtures**

Fetch real entries once to check the live shape (needs internet; do not commit raw output):

```bash
curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers?search=opnsense&limit=3&version=latest' | head -c 4000
curl -s 'https://registry.modelcontextprotocol.io/v0.1/servers?search=filesystem&limit=3&version=latest' | head -c 4000
```

Compare with the shape below (`{ servers: [{ server, _meta: { "io.modelcontextprotocol.registry/official": { status, publishedAt, updatedAt, isLatest } } }], metadata: { nextCursor, count } }`). The fixtures are written by hand in that shape, trimmed to the fields the normaliser reads plus one unknown field each; if the live API differs in a field name the normaliser reads, adjust both the fixture and `normalise.js` and note it in the commit.

`tests/fixtures/mcp-registry/opnsense.json`:

```json
{
  "server": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
    "name": "io.github.example/opnsense-mcp-server",
    "title": "OPNsense",
    "description": "Manage an OPNsense firewall: rules, aliases, DHCP and diagnostics.",
    "version": "0.4.1",
    "repository": {
      "url": "https://github.com/example/opnsense-mcp-server",
      "source": "github"
    },
    "websiteUrl": "https://example.test/opnsense",
    "icons": [{ "src": "https://example.test/icon.png" }],
    "futureField": { "ignored": true },
    "packages": [
      {
        "registryType": "npm",
        "registryBaseUrl": "https://registry.npmjs.org",
        "identifier": "opnsense-mcp-server",
        "version": "0.4.1",
        "runtimeHint": "npx",
        "transport": { "type": "stdio" },
        "packageArguments": [{ "type": "named", "name": "--log-level", "value": "info" }],
        "environmentVariables": [
          {
            "name": "OPNSENSE_URL",
            "description": "Address of your OPNsense",
            "isRequired": true
          },
          {
            "name": "OPNSENSE_API_KEY",
            "description": "API key from OPNsense",
            "isRequired": true,
            "isSecret": true
          },
          {
            "name": "OPNSENSE_API_SECRET",
            "description": "Matching secret",
            "isRequired": true,
            "isSecret": true
          },
          {
            "name": "OPNSENSE_VERIFY_SSL",
            "description": "Check the certificate",
            "format": "boolean",
            "default": "true"
          },
          {
            "name": "OPNSENSE_ALLOW_WRITES",
            "description": "Allow write access",
            "format": "boolean",
            "default": "false"
          }
        ]
      },
      {
        "registryType": "oci",
        "identifier": "ghcr.io/example/opnsense-mcp-server",
        "version": "0.4.1",
        "transport": { "type": "stdio" }
      }
    ],
    "_meta": {
      "io.modelcontextprotocol.registry/publisher-provided": { "tool": "<b>x</b>" }
    }
  },
  "_meta": {
    "io.modelcontextprotocol.registry/official": {
      "status": "active",
      "publishedAt": "2025-10-01T10:00:00Z",
      "updatedAt": "2025-10-02T10:00:00Z",
      "isLatest": true
    }
  }
}
```

`remote-filesystem.json` (remote with a URL template and a secret header):

```json
{
  "server": {
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "name": "com.pulsemcp/remote-filesystem",
    "description": "Read and write files in a hosted workspace.",
    "version": "1.2.0",
    "remotes": [
      {
        "type": "streamable-http",
        "url": "https://{tenant}.files.example.test/mcp",
        "variables": {
          "tenant": { "description": "Your tenant id", "isRequired": true }
        },
        "headers": [
          {
            "name": "Authorization",
            "description": "Bearer token",
            "isRequired": true,
            "isSecret": true,
            "value": "Bearer {token}",
            "variables": { "token": { "isSecret": true, "isRequired": true } }
          }
        ]
      },
      { "type": "sse", "url": "https://files.example.test/sse" }
    ]
  },
  "_meta": {
    "io.modelcontextprotocol.registry/official": {
      "status": "active",
      "publishedAt": "2025-11-01T00:00:00Z"
    }
  }
}
```

`smithery-remote.json`:

```json
{
  "server": {
    "name": "ai.smithery/example-weather",
    "description": "Weather forecasts.",
    "version": "2025.10.1",
    "remotes": [
      {
        "type": "streamable-http",
        "url": "https://server.smithery.ai/example/weather/mcp"
      }
    ]
  },
  "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active" } }
}
```

`oci-only.json`:

```json
{
  "server": {
    "name": "io.github.example/container-only",
    "description": "Runs only as a container.",
    "version": "1.0.0",
    "packages": [
      {
        "registryType": "oci",
        "identifier": "docker.io/example/server",
        "version": "1.0.0",
        "transport": { "type": "stdio" }
      }
    ]
  },
  "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active" } }
}
```

`deleted.json`:

```json
{
  "server": {
    "name": "ai.smithery/gone",
    "description": "Removed by its publisher.",
    "version": "1.0.0",
    "remotes": [
      { "type": "streamable-http", "url": "https://server.smithery.ai/gone/mcp" }
    ]
  },
  "_meta": { "io.modelcontextprotocol.registry/official": { "status": "deleted" } }
}
```

`deprecated.json`:

```json
{
  "server": {
    "name": "ai.smithery/old",
    "description": "Old weather server.",
    "version": "1.0.0",
    "remotes": [
      { "type": "streamable-http", "url": "https://server.smithery.ai/old/mcp" }
    ]
  },
  "_meta": {
    "io.modelcontextprotocol.registry/official": {
      "status": "deprecated",
      "statusMessage": "Use ai.smithery/example-weather instead."
    }
  }
}
```

`oversize.json` (build the long strings with a one-off script so the file stays readable in review: `node -e 'const r=(c,n)=>c.repeat(n);console.log(JSON.stringify({server:{name:"io.github.example/long",title:r("T",150),description:r("d",400),version:"1.0.0",packages:[{registryType:"npm",identifier:"long-server",version:"1.0.0",transport:{type:"stdio"},environmentVariables:[{name:"LONG",description:r("e",600)}],packageArguments:[{type:"positional",isRequired:true,valueHint:"path"}]}]},_meta:{"io.modelcontextprotocol.registry/official":{status:"active"}}},null,2))' > tests/fixtures/mcp-registry/oversize.json`).

`bidi.json`:

```json
{
  "server": {
    "name": "io.github.example/bidi",
    "title": "Safe\u202eexe.txt",
    "description": "line\u0000one\u200f two",
    "version": "1.0.0",
    "repository": { "url": "javascript:alert(1)" },
    "websiteUrl": "https://user:pw@example.test",
    "packages": [
      {
        "registryType": "pypi",
        "registryBaseUrl": "https://evil.example.test/simple",
        "identifier": "fetch",
        "version": "1.0",
        "transport": { "type": "stdio" }
      }
    ]
  },
  "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active" } }
}
```

`list.json`:

```json
{
  "servers": [],
  "metadata": { "nextCursor": "io.github.example/opnsense-mcp-server:0.4.1", "count": 4 }
}
```

(the test fills `servers` from the other fixtures).

- [ ] **Step 2: Write the failing test**

`tests/unit/mcp-directory-normalise.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fc from "fast-check";
import {
  cursorOf,
  normaliseDetail,
  normaliseEntry,
  normaliseList,
} from "../../server/features/mcp-directory/normalise.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("an npm entry becomes an installable option with its settings", () => {
  const entry = normaliseEntry(fixture("opnsense"));
  assert.equal(entry.name, "io.github.example/opnsense-mcp-server");
  assert.equal(entry.namespace, "io.github.example");
  assert.equal(entry.title, "OPNsense");
  assert.equal(entry.status, "active");
  assert.equal(entry.publishedAt, "2025-10-01T10:00:00Z");
  assert.equal(entry.repositoryUrl, "https://github.com/example/opnsense-mcp-server");
  assert.equal(entry.installable, true);
  const [npm, oci] = entry.options;
  assert.equal(npm.kind, "npm");
  assert.deepEqual(
    [npm.identifier, npm.version, npm.transport],
    ["opnsense-mcp-server", "0.4.1", "stdio"],
  );
  assert.deepEqual(npm.packageArgs, ["--log-level", "info"]);
  assert.deepEqual(npm.ignored, ["runtimeHint"]);
  assert.deepEqual(
    npm.env.map(({ name, required, secret, format, default: value }) => [
      name,
      required,
      secret,
      format,
      value,
    ]),
    [
      ["OPNSENSE_URL", true, false, "string", null],
      ["OPNSENSE_API_KEY", true, true, "string", null],
      ["OPNSENSE_API_SECRET", true, true, "string", null],
      ["OPNSENSE_VERIFY_SSL", false, false, "boolean", "true"],
      ["OPNSENSE_ALLOW_WRITES", false, false, "boolean", "false"],
    ],
  );
  assert.deepEqual(
    [oci.kind, oci.unsupportedReason, oci.registryType],
    ["unsupported", "registryType", "oci"],
  );
  assert.equal(JSON.stringify(entry).includes("icon.png"), false);
  assert.equal(JSON.stringify(entry).includes("<b>"), false);
  assert.equal(JSON.stringify(entry).includes("futureField"), false);
});

test("remotes become HTTP or SSE options with URL and header variables", () => {
  const entry = normaliseEntry(fixture("remote-filesystem"));
  const [http, sse] = entry.options;
  assert.deepEqual(
    [http.kind, http.transport, http.url],
    ["remote-http", "http", "https://{tenant}.files.example.test/mcp"],
  );
  assert.deepEqual(http.urlVariables, [
    {
      name: "tenant",
      description: "Your tenant id",
      required: true,
      secret: false,
      default: null,
      choices: [],
    },
  ]);
  assert.equal(http.headers[0].name, "Authorization");
  assert.equal(http.headers[0].value, "Bearer {token}");
  assert.deepEqual(
    http.headers[0].variables.map((v) => [v.name, v.secret]),
    [["token", true]],
  );
  assert.deepEqual([sse.kind, sse.url], ["remote-sse", "https://files.example.test/sse"]);
  assert.equal(normaliseEntry(fixture("smithery-remote")).installable, true);
});

test("unsupported, deleted and deprecated entries", () => {
  const oci = normaliseEntry(fixture("oci-only"));
  assert.equal(oci.installable, false);
  assert.equal(normaliseEntry(fixture("deleted")), null);
  const old = normaliseEntry(fixture("deprecated"));
  assert.deepEqual(
    [old.status, old.statusMessage],
    ["deprecated", "Use ai.smithery/example-weather instead."],
  );
  assert.throws(
    () => normaliseDetail(fixture("deleted")),
    (error) => error.code === "MCP_DIRECTORY_NOT_FOUND",
  );
  assert.throws(
    () => normaliseDetail({ server: { name: 5 } }),
    (error) => error.code === "MCP_DIRECTORY_INVALID",
  );
});

test("oversize strings are cut and a required argument without value is unsupported", () => {
  const entry = normaliseEntry(fixture("oversize"));
  assert.equal(entry.title.length, 100);
  assert.ok(entry.title.endsWith("…"));
  assert.equal(entry.description.length, 300);
  assert.equal(entry.options[0].kind, "unsupported");
  assert.equal(entry.options[0].unsupportedReason, "argument");
  assert.ok(entry.options[0].env[0].description.length <= 500);
});

test("control and bidi characters are stripped; unsafe links and registries dropped", () => {
  const entry = normaliseEntry(fixture("bidi"));
  assert.equal(entry.title, "Safeexe.txt");
  assert.equal(entry.description, "lineone two");
  assert.equal(entry.repositoryUrl, null);
  assert.equal(entry.websiteUrl, null);
  assert.deepEqual(
    [entry.options[0].kind, entry.options[0].unsupportedReason],
    ["unsupported", "registryBaseUrl"],
  );
});

test("schema versions: known and later dates accepted, earlier refused", () => {
  const withSchema = (date) => {
    const item = fixture("smithery-remote");
    item.server.$schema = `https://static.modelcontextprotocol.io/schemas/${date}/server.schema.json`;
    return normaliseEntry(item);
  };
  for (const date of ["2025-09-16", "2025-09-29", "2025-12-11", "2026-07-01"])
    assert.ok(withSchema(date), date);
  assert.equal(withSchema("2025-07-09"), null);
});

test("lists drop invalid entries and pass back a safe cursor only", () => {
  const body = fixture("list");
  body.servers = [
    fixture("opnsense"),
    fixture("deleted"),
    { server: { name: "bad name" } },
    fixture("oci-only"),
  ];
  const { entries, nextCursor } = normaliseList(body);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["io.github.example/opnsense-mcp-server", "io.github.example/container-only"],
  );
  assert.equal(nextCursor, "io.github.example/opnsense-mcp-server:0.4.1");
  assert.equal(cursorOf("a b"), null);
  assert.equal(cursorOf("x".repeat(513)), null);
  assert.equal(cursorOf(42), null);
  assert.deepEqual(normaliseList({ nope: true }), { entries: [], nextCursor: null });
});

test("property: any input normalises without throwing and without control characters", () => {
  fc.assert(
    fc.property(fc.anything({ maxDepth: 4 }), (item) => {
      const entry = normaliseEntry(item);
      if (!entry) return;
      assert.doesNotMatch(JSON.stringify(entry), /[\u0000-\u001f‪-‮]/);
    }),
  );
  fc.assert(
    fc.property(
      fc.record({ title: fc.string(), description: fc.string({ maxLength: 2000 }) }),
      ({ title, description }) => {
        const item = fixture("smithery-remote");
        Object.assign(item.server, { title, description });
        const entry = normaliseEntry(item);
        assert.ok(entry.title.length <= 100 && entry.description.length <= 300);
      },
    ),
  );
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/unit/mcp-directory-normalise.test.js`
Expected: FAIL – module not found.

- [ ] **Step 4: Implement**

`server/features/mcp-directory/normalise.js`:

```js
import { plainText, webLink } from "../mcp-packages/publisher-info.js";
import { packageRef } from "../mcp-packages/package-spec.js";

// The MCP Registry's server.json is untrusted: every field is read by name, checked
// and capped; unknown fields, icons and publisher-provided _meta are ignored. The
// browser only ever sees this DTO.
const official = "io.modelcontextprotocol.registry/official";
const namePattern = /^[A-Za-z0-9.-]{1,150}\/[A-Za-z0-9._-]{1,150}$/;
const schemaPattern = /\/schemas\/(\d{4}-\d{2}-\d{2})\/server\.schema\.json$/;
const firstSchema = "2025-09-16";
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const variableName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const isoDate =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const bases = { npm: "https://registry.npmjs.org", pypi: "https://pypi.org" };
const limits = { options: 20, inputs: 100, choices: 50, args: 100, url: 2048 };
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, cap) => plainText(value, cap) ?? "";
const bool = (value) => value === true;

const notFound = () =>
  Object.assign(new Error("deleted"), { code: "MCP_DIRECTORY_NOT_FOUND" });
const invalid = () =>
  Object.assign(new Error("invalid"), { code: "MCP_DIRECTORY_INVALID" });

/** A cursor as the registry sent it, if it is short printable ASCII; else null. */
export const cursorOf = (value) =>
  typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null;

function variables(map) {
  if (!isRecord(map)) return [];
  return Object.entries(map)
    .filter(([name, value]) => variableName.test(name) && isRecord(value))
    .slice(0, limits.inputs)
    .map(([name, value]) => ({
      name,
      description: text(value.description, 500),
      required: bool(value.isRequired),
      secret: bool(value.isSecret),
      default: plainText(value.default, 16384),
      choices: Array.isArray(value.choices)
        ? value.choices
            .slice(0, limits.choices)
            .map((c) => text(c, 200))
            .filter(Boolean)
        : [],
    }));
}

function inputs(list, kind) {
  if (!Array.isArray(list)) return [];
  const rule = kind === "header" ? headerName : envName;
  return list
    .filter(
      (item) => isRecord(item) && typeof item.name === "string" && rule.test(item.name),
    )
    .slice(0, limits.inputs)
    .map((item) => ({
      name: item.name,
      description: text(item.description, 500),
      required: bool(item.isRequired),
      secret: bool(item.isSecret),
      format: typeof item.format === "string" ? text(item.format, 20) : "string",
      default: plainText(item.default, 16384),
      choices: Array.isArray(item.choices)
        ? item.choices
            .slice(0, limits.choices)
            .map((c) => text(c, 200))
            .filter(Boolean)
        : [],
      value: plainText(item.value, 16384),
      variables: variables(item.variables),
    }));
}

/** An http(s) URL that may hold `{var}` templates; the template must be valid. */
function templateUrl(value) {
  if (typeof value !== "string" || value.length > limits.url) return null;
  const probe = value.replace(/\{[A-Za-z_][A-Za-z0-9_-]{0,63}\}/g, "x");
  if (/[{}]/.test(probe) || !webLink(probe)) return null;
  return value;
}

const urlVariables = (url, declared) => {
  const names = [
    ...new Set([...url.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}/g)].map((m) => m[1])),
  ];
  const known = new Map(variables(declared).map((v) => [v.name, v]));
  return names.map(
    (name) =>
      known.get(name) ?? {
        name,
        description: "",
        required: true,
        secret: false,
        default: null,
        choices: [],
      },
  );
};

const blank = (extra) => ({
  kind: "unsupported",
  identifier: "",
  version: "",
  transport: "stdio",
  url: null,
  urlVariables: [],
  env: [],
  headers: [],
  packageArgs: [],
  ignored: [],
  unsupportedReason: null,
  ...extra,
});

/** Package arguments as rows; null when one needs a secret or the owner's own value. */
function packageArgs(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const rows = [];
  for (const arg of list.slice(0, limits.args)) {
    if (!isRecord(arg) || arg.isSecret === true) return null;
    const value = plainText(arg.value ?? arg.default, 16384);
    if (value !== null && /\{[^}]+\}/.test(value)) return null;
    if (value === null && arg.isRequired === true) return null;
    if (arg.type === "named") {
      const name =
        typeof arg.name === "string" && /^-{1,2}[A-Za-z0-9][\w.-]{0,63}$/.test(arg.name)
          ? arg.name
          : null;
      if (!name) return null;
      rows.push(name, ...(value === null ? [] : [value]));
    } else if (value !== null) rows.push(value);
  }
  return rows;
}

/** "ok" for a valid name and exact version, else which of the two is wrong. */
function refCheck(registry, name, version) {
  try {
    packageRef({ registry, name, version });
    return "ok";
  } catch {
    try {
      packageRef({ registry, name, version: registry === "npm" ? "1.0.0" : "1.0" });
      return "version";
    } catch {
      return "identifier";
    }
  }
}

function packageOption(pkg) {
  if (!isRecord(pkg)) return blank({ unsupportedReason: "registryType" });
  const registry = pkg.registryType;
  const transport = isRecord(pkg.transport)
    ? text(pkg.transport.type, 30) || "stdio"
    : "stdio";
  const shown = {
    identifier: text(pkg.identifier, 214),
    version: text(pkg.version, 128),
    transport,
  };
  if (registry !== "npm" && registry !== "pypi")
    return blank({
      ...shown,
      unsupportedReason: "registryType",
      registryType: text(registry, 30),
    });
  if (pkg.registryBaseUrl !== undefined && pkg.registryBaseUrl !== bases[registry])
    return blank({ ...shown, unsupportedReason: "registryBaseUrl" });
  const check = refCheck(registry, pkg.identifier, pkg.version);
  if (check !== "ok") return blank({ ...shown, unsupportedReason: check });
  if (transport !== "stdio") return blank({ ...shown, unsupportedReason: "transport" });
  const args = packageArgs(pkg.packageArguments);
  if (args === null)
    return blank({
      ...shown,
      unsupportedReason: "argument",
      env: inputs(pkg.environmentVariables, "env"),
    });
  return blank({
    ...shown,
    kind: registry,
    identifier: pkg.identifier,
    version: pkg.version,
    env: inputs(pkg.environmentVariables, "env"),
    packageArgs: args,
    ignored: [
      ...(pkg.runtimeHint !== undefined ? ["runtimeHint"] : []),
      ...(Array.isArray(pkg.runtimeArguments) && pkg.runtimeArguments.length
        ? ["runtimeArguments"]
        : []),
    ],
  });
}

function remoteOption(remote) {
  if (!isRecord(remote)) return blank({ unsupportedReason: "transport" });
  const type = remote.type;
  const kind =
    type === "streamable-http" || type === "streamableHttp" || type === "http"
      ? "remote-http"
      : type === "sse"
        ? "remote-sse"
        : null;
  if (!kind) return blank({ transport: text(type, 30), unsupportedReason: "transport" });
  const url = templateUrl(remote.url);
  if (!url)
    return blank({
      transport: kind === "remote-sse" ? "sse" : "http",
      unsupportedReason: "url",
    });
  return blank({
    kind,
    transport: kind === "remote-sse" ? "sse" : "http",
    url,
    urlVariables: urlVariables(url, remote.variables),
    headers: inputs(remote.headers, "header"),
  });
}

const schemaAccepted = (schema) => {
  if (schema === undefined) return true;
  const date = typeof schema === "string" ? schemaPattern.exec(schema)?.[1] : null;
  return Boolean(date) && date >= firstSchema;
};

function statusOf(item, server) {
  const meta = isRecord(item._meta?.[official])
    ? item._meta[official]
    : isRecord(server._meta?.[official])
      ? server._meta[official]
      : {};
  const raw = meta.status ?? server.status;
  return {
    status:
      raw === "deleted" ? "deleted" : raw === "deprecated" ? "deprecated" : "active",
    statusMessage: text(meta.statusMessage ?? server.statusMessage, 300),
    publishedAt:
      [meta.publishedAt, meta.updatedAt].find(
        (v) => typeof v === "string" && isoDate.test(v) && Number.isFinite(Date.parse(v)),
      ) ?? null,
  };
}

/** One registry item as the DTO, or null for an invalid or deleted entry. */
export function normaliseEntry(item) {
  if (!isRecord(item)) return null;
  const server = isRecord(item.server) ? item.server : item;
  if (typeof server.name !== "string" || !namePattern.test(server.name)) return null;
  if (typeof server.version !== "string" || !/^[\x21-\x7e]{1,128}$/.test(server.version))
    return null;
  if (!schemaAccepted(server.$schema)) return null;
  const state = statusOf(item, server);
  if (state.status === "deleted") return null;
  const options = [
    ...(Array.isArray(server.packages) ? server.packages : []).map(packageOption),
    ...(Array.isArray(server.remotes) ? server.remotes : []).map(remoteOption),
  ].slice(0, limits.options);
  return {
    name: server.name,
    title: text(server.title, 100),
    description: text(server.description, 300),
    version: server.version,
    namespace: server.name.split("/")[0],
    ...state,
    repositoryUrl: webLink(isRecord(server.repository) ? server.repository.url : null),
    websiteUrl: webLink(server.websiteUrl),
    options,
    installable: options.some((option) => option.kind !== "unsupported"),
  };
}

export function normaliseList(body) {
  const list =
    isRecord(body) && Array.isArray(body.servers) ? body.servers.slice(0, 100) : [];
  return {
    entries: list.map(normaliseEntry).filter(Boolean),
    nextCursor: cursorOf(
      isRecord(body?.metadata)
        ? (body.metadata.nextCursor ?? body.metadata.next_cursor)
        : null,
    ),
  };
}

export function normaliseDetail(body) {
  if (!isRecord(body)) throw invalid();
  const server = isRecord(body.server) ? body.server : body;
  if (statusOf(body, server).status === "deleted") throw notFound();
  const entry = normaliseEntry(body);
  if (!entry) throw invalid();
  return entry;
}
```

`plainText` collapses whitespace and strips control/bidi characters (PR 1), so `"line\u0000one‏ two"` becomes `"lineone two"`.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-normalise.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/mcp-directory/normalise.js tests/fixtures/mcp-registry tests/unit/mcp-directory-normalise.test.js
git commit -m "feat: normalise MCP Registry entries into a safe directory DTO

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: In-memory cache

**Files:**

- Create: `server/features/mcp-directory/cache.js`
- Test: `tests/unit/mcp-directory-cache.test.js`

**Interfaces:**

- Produces: `class TtlCache { constructor({ limit = 200, now = Date.now }); get(key) → value|undefined; set(key, value, ttlMs); clear(); get size }`; `searchKey(baseUrl, search, cursor) → string`, `detailKey(baseUrl, name) → string`, `healthKey(baseUrl)`; `ttl = { success: 3_600_000, negative: 60_000, health: 300_000 }`; `normaliseSearch(text) → string` (trimmed, lower-cased, ≤ 100 chars).

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  detailKey,
  normaliseSearch,
  searchKey,
  ttl,
  TtlCache,
} from "../../server/features/mcp-directory/cache.js";

test("entries expire after their TTL on the injected clock", () => {
  let now = 0;
  const cache = new TtlCache({ now: () => now });
  cache.set("a", 1, ttl.success);
  now = ttl.success - 1;
  assert.equal(cache.get("a"), 1);
  now = ttl.success;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("the least recently used entry leaves first at the limit", () => {
  const cache = new TtlCache({ limit: 2, now: () => 0 });
  cache.set("a", 1, 10);
  cache.set("b", 2, 10);
  cache.get("a");
  cache.set("c", 3, 10);
  assert.deepEqual([cache.get("a"), cache.get("b"), cache.get("c")], [1, undefined, 3]);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("search keys ignore case and spaces; bases never share entries", () => {
  assert.equal(normaliseSearch("  GitHub  "), "github");
  assert.equal(normaliseSearch("x".repeat(150)).length, 100);
  assert.equal(
    searchKey("https://a.test", " GitHub ", ""),
    searchKey("https://a.test", "github", ""),
  );
  assert.notEqual(
    searchKey("https://a.test", "github", ""),
    searchKey("https://b.test", "github", ""),
  );
  assert.notEqual(
    searchKey("https://a.test", "github", ""),
    searchKey("https://a.test", "github", "c1"),
  );
  assert.notEqual(
    detailKey("https://a.test", "x/y"),
    searchKey("https://a.test", "x/y", ""),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-directory-cache.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// Directory answers kept in memory only, per base URL and query; no disk, no prefetch.
export const ttl = {
  success: 60 * 60 * 1000,
  negative: 60 * 1000,
  health: 5 * 60 * 1000,
};

export const normaliseSearch = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 100);
export const searchKey = (base, search, cursor = "") =>
  JSON.stringify(["search", base, normaliseSearch(search), cursor]);
export const detailKey = (base, name) => JSON.stringify(["detail", base, name]);
export const healthKey = (base) => JSON.stringify(["health", base]);

export class TtlCache {
  constructor({ limit = 200, now = Date.now } = {}) {
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
  }
  get size() {
    return this.entries.size;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expires) {
      this.entries.delete(key);
      return undefined;
    }
    // Map order is the use order: the oldest key leaves first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, lifetime) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + lifetime });
    while (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value);
  }
  clear() {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-cache.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-directory/cache.js tests/unit/mcp-directory-cache.test.js
git commit -m "feat: cache MCP directory answers in memory for an hour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Directory client

**Files:**

- Create: `server/features/mcp-directory/client.js`
- Test: `tests/unit/mcp-directory-client.test.js`

**Interfaces:**

- Consumes: Tasks 1–3, Task 6 (`directoryProblem`); `download as fetchDownload` from `server/features/operations/releases.js`.
- Produces: `class McpDirectory { constructor({ settings: () => { enabled, baseUrl }, fetchImpl = fetch, now = Date.now, log = console.error, deadlineMs = 10000 }); status() → Promise<{ enabled, host, reachable }>; search({ search, cursor }) → Promise<{ entries, nextCursor }>; detail(name) → Promise<Entry>; clear() }`. Errors are `directoryProblem(code)` with `code` in `MCP_DIRECTORY_DISABLED|UNAVAILABLE|NOT_FOUND|INVALID|INVALID_REQUEST`. Size caps `listLimit = 2 MiB`, `detailLimit = 512 KiB`.

- [ ] **Step 1: Write the failing test**

`tests/unit/mcp-directory-client.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { McpDirectory } from "../../server/features/mcp-directory/client.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function client({
  handler,
  settings = { enabled: true, baseUrl: "https://registry.test" },
  now = () => 0,
}) {
  const calls = [];
  const logs = [];
  const directory = new McpDirectory({
    settings: () => settings,
    now,
    log: (line) => logs.push(line),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(new URL(url), init);
    },
  });
  return { directory, calls, logs };
}

test("search asks the registry once per hour and normalises the answer", async () => {
  let now = 0;
  const { directory, calls } = client({
    now: () => now,
    handler: () =>
      json({ servers: [fixture("opnsense")], metadata: { nextCursor: "c1" } }),
  });
  const first = await directory.search({ search: "  OPNsense " });
  assert.equal(first.entries[0].name, "io.github.example/opnsense-mcp-server");
  assert.equal(first.nextCursor, "c1");
  await directory.search({ search: "opnsense" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v0.1/servers");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    search: "opnsense",
    limit: "30",
    version: "latest",
  });
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(calls[0].init.headers.authorization, undefined);
  now = 60 * 60 * 1000;
  await directory.search({ search: "opnsense" });
  assert.equal(calls.length, 2);
});

test("detail encodes the name as one segment; 404 and deleted are not found", async () => {
  const { directory, calls } = client({
    handler: (url) =>
      url.pathname.includes("gone")
        ? json({}, { status: 404 })
        : json(fixture("opnsense")),
  });
  const entry = await directory.detail("io.github.example/opnsense-mcp-server");
  assert.equal(entry.version, "0.4.1");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/v0.1/servers/io.github.example%2Fopnsense-mcp-server/versions/latest",
  );
  await assert.rejects(
    directory.detail("io.github.example/gone"),
    (e) => e.code === "MCP_DIRECTORY_NOT_FOUND" && e.status === 404,
  );
  await assert.rejects(
    directory.detail("bad name"),
    (e) => e.code === "MCP_DIRECTORY_INVALID_REQUEST",
  );
});

test("429 and 5xx are cached for 60 s; other failures are not cached", async () => {
  let now = 0;
  let status = 429;
  const { directory, calls, logs } = client({
    now: () => now,
    handler: () => json({}, { status }),
  });
  await assert.rejects(
    directory.search({ search: "x" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE" && e.status === 503,
  );
  await assert.rejects(
    directory.search({ search: "x" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
  );
  assert.equal(calls.length, 1);
  now = 60 * 1000;
  status = 400;
  await assert.rejects(directory.search({ search: "x" }));
  await assert.rejects(directory.search({ search: "x" }));
  assert.equal(calls.length, 3);
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every((line) => line.includes("registry.test") && !line.includes("search")),
  );
});

test("invalid JSON, oversize bodies and a foreign redirect are unavailable", async () => {
  for (const handler of [
    () => new Response("{not json", { status: 200 }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/v0.1/servers" },
      }),
  ]) {
    const { directory } = client({ handler });
    await assert.rejects(
      directory.search({ search: "q" }),
      (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
    );
  }
});

test("an invalid detail answers 502; a slow registry times out", async () => {
  const { directory } = client({ handler: () => json({ server: { name: 1 } }) });
  await assert.rejects(
    directory.detail("a.b/c"),
    (e) => e.code === "MCP_DIRECTORY_INVALID" && e.status === 502,
  );
  const slow = new McpDirectory({
    settings: () => ({ enabled: true, baseUrl: "https://registry.test" }),
    deadlineMs: 20,
    log: () => {},
    fetchImpl: (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      ),
  });
  await assert.rejects(
    slow.search({ search: "q" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
  );
});

test("disabled: no request, 409; status reports host and health", async () => {
  const settings = { enabled: false, baseUrl: "https://registry.test" };
  const { directory, calls } = client({
    settings,
    handler: () => json({ status: "ok" }),
  });
  await assert.rejects(
    directory.search({ search: "q" }),
    (e) => e.code === "MCP_DIRECTORY_DISABLED" && e.status === 409,
  );
  assert.deepEqual(await directory.status(), {
    enabled: false,
    host: "registry.test",
    reachable: false,
  });
  assert.equal(calls.length, 0);
  settings.enabled = true;
  assert.deepEqual(await directory.status(), {
    enabled: true,
    host: "registry.test",
    reachable: true,
  });
  await directory.status();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/v0.1/health");
});

test("a bad cursor is refused; an unsafe next cursor is dropped", async () => {
  const { directory } = client({
    handler: () => json({ servers: [], metadata: { nextCursor: "a b" } }),
  });
  await assert.rejects(
    directory.search({ search: "q", cursor: "x".repeat(600) }),
    (e) => e.code === "MCP_DIRECTORY_INVALID_REQUEST",
  );
  assert.equal((await directory.search({ search: "q" })).nextCursor, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/mcp-directory-client.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/features/mcp-directory/client.js`:

```js
import { download as fetchDownload } from "../operations/releases.js";
import {
  detailKey,
  healthKey,
  normaliseSearch,
  searchKey,
  ttl,
  TtlCache,
} from "./cache.js";
import { directoryProblem } from "./directory-errors.js";
import { isLoopbackHost } from "./directory-settings.js";
import { cursorOf, normaliseDetail, normaliseList } from "./normalise.js";

// The MCP Registry, asked on demand only (decision Q1): an owner search, an opened
// detail, the Source card's health check or the MCP list's update check.
export const listLimit = 2 * 1024 * 1024;
export const detailLimit = 512 * 1024;
const healthLimit = 64 * 1024;
const namePattern = /^[A-Za-z0-9.-]{1,150}\/[A-Za-z0-9._-]{1,150}$/;
const negative = (status) => status === 429 || (status >= 500 && status <= 599);

/** A loopback http registry (tests, local subregistries): no redirects, size-capped. */
async function loopbackDownload(url, fetchImpl, limit, headers) {
  const response = await fetchImpl(url, { redirect: "manual", headers });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Object.assign(new Error("redirect"), { status: 502 });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("status"), { status: response.status });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export class McpDirectory {
  constructor({
    settings,
    fetchImpl = fetch,
    now = Date.now,
    log = console.error,
    deadlineMs = 10000,
  }) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.deadlineMs = deadlineMs;
    this.cache = new TtlCache({ now });
  }
  clear() {
    this.cache.clear();
  }
  current() {
    const settings = this.settings();
    return { ...settings, host: new URL(settings.baseUrl).host };
  }
  enabled() {
    const settings = this.current();
    if (!settings.enabled) throw directoryProblem("MCP_DIRECTORY_DISABLED");
    return settings;
  }
  /**
   * Bytes of `url`, with origin pinning, a size cap and one overall deadline. A
   * failure carries `upstream`: the registry's last HTTP status (0 without one).
   */
  async fetchBytes(url, limit) {
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const seen = { status: 0 };
    const fetchImpl = async (target, init = {}) => {
      const response = await this.fetchImpl(target, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
      seen.status = response.status;
      return response;
    };
    const headers = { accept: "application/json" };
    const parsed = new URL(url);
    try {
      if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
        return await loopbackDownload(url, fetchImpl, limit, headers);
      return await fetchDownload(url, fetchImpl, limit, {
        headers,
        pinOrigin: true,
        retries: 0,
      });
    } catch (error) {
      throw Object.assign(new Error("MCP directory download failed", { cause: error }), {
        upstream: seen.status,
      });
    }
  }
  /** JSON from the registry, cached; failures map to stable directory codes. */
  async request({ key, url, limit, lifetime, host }) {
    const cached = this.cache.get(key);
    if (cached?.error) throw directoryProblem(cached.error);
    if (cached) return cached.body;
    let bytes;
    try {
      bytes = await this.fetchBytes(url, limit);
    } catch (failure) {
      const upstream = failure?.upstream ?? 0;
      const code =
        upstream === 404 ? "MCP_DIRECTORY_NOT_FOUND" : "MCP_DIRECTORY_UNAVAILABLE";
      // 429 and 5xx: the registry asked for a pause; do not ask again for 60 s.
      if (negative(upstream)) this.cache.set(key, { error: code }, ttl.negative);
      // Code and host only: never the search term or the address.
      this.log(`AgentPier MCP directory request failed (${code}, ${host}).`);
      throw directoryProblem(code);
    }
    let body;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.log(
        `AgentPier MCP directory request failed (MCP_DIRECTORY_UNAVAILABLE, ${host}).`,
      );
      throw directoryProblem("MCP_DIRECTORY_UNAVAILABLE");
    }
    this.cache.set(key, { body }, lifetime);
    return body;
  }
  async search({ search = "", cursor = "" } = {}) {
    const { baseUrl, host } = this.enabled();
    if (cursor && !cursorOf(cursor))
      throw directoryProblem("MCP_DIRECTORY_INVALID_REQUEST");
    const query = new URLSearchParams({
      search: normaliseSearch(search),
      limit: "30",
      version: "latest",
    });
    if (cursor) query.set("cursor", cursor);
    const body = await this.request({
      key: searchKey(baseUrl, search, cursor),
      url: `${baseUrl}/v0.1/servers?${query}`,
      limit: listLimit,
      lifetime: ttl.success,
      host,
    });
    return normaliseList(body);
  }
  async detail(name) {
    const { baseUrl, host } = this.enabled();
    if (typeof name !== "string" || !namePattern.test(name))
      throw directoryProblem("MCP_DIRECTORY_INVALID_REQUEST");
    const body = await this.request({
      key: detailKey(baseUrl, name),
      url: `${baseUrl}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`,
      limit: detailLimit,
      lifetime: ttl.success,
      host,
    });
    try {
      return normaliseDetail(body);
    } catch (error) {
      throw directoryProblem(
        error.code === "MCP_DIRECTORY_NOT_FOUND" ? error.code : "MCP_DIRECTORY_INVALID",
      );
    }
  }
  async status() {
    const { enabled, baseUrl, host } = this.current();
    if (!enabled) return { enabled, host, reachable: false };
    try {
      await this.request({
        key: healthKey(baseUrl),
        url: `${baseUrl}/v0.1/health`,
        limit: healthLimit,
        lifetime: ttl.health,
        host,
      });
      return { enabled, host, reachable: true };
    } catch {
      return { enabled, host, reachable: false };
    }
  }
}
```

`download()` refuses any non-https URL (`httpsDownloadRequired`), which is why loopback http goes through `loopbackDownload`. The failure's `upstream` status decides the code (404 → not found) and the negative cache (429, 5xx), for both download paths alike.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/mcp-directory-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/mcp-directory/client.js tests/unit/mcp-directory-client.test.js
git commit -m "feat: query the MCP Registry on demand with caps, deadline and pinned origin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Setting, routes and wiring

**Files:**

- Create: `server/http/routes/mcp-directory.js`, `tests/helpers/fake-mcp-registry.js`, `tests/integration/mcp-directory-routes.test.js`
- Modify: `server/features/settings/preferences.js`, `server/http/routes/workspace.js`, `server/http/responses.js`, `server/application/services.js`, `server/app.js`, `tests/integration/preferences.test.js` (+ any other exact `preferences.get()` expectation; find them with `grep -rn "autoResumeInterrupted: true" tests`)

**Interfaces:**

- Consumes: `McpDirectory` (Task 4), `directorySettings`, `normaliseBaseUrl` (Task 1).
- Produces:
  - `preferences.get().mcpDirectory = { enabled, baseUrl }`; `preferences.update({ mcpDirectory: { enabled?, baseUrl? } })` (`baseUrl: null` resets to the default).
  - `services.mcpDirectory` (`McpDirectory`), cleared on every `PATCH /preferences` that carries `mcpDirectory`.
  - Routes as in Global Constraints. Error bodies carry `code` for `MCP_DIRECTORY_*`.

- [ ] **Step 1: The fake registry**

`tests/helpers/fake-mcp-registry.js`:

```js
import http from "node:http";

/** A loopback registry: `routes[pathname] = (url) => ({ status, body, headers })`. */
export async function fakeRegistry(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });
    const handler = routes[url.pathname] ?? routes["*"];
    const answer = handler ? handler(url) : { status: 404, body: {} };
    if (answer.delay) return setTimeout(() => res.end(), answer.delay);
    res.writeHead(answer.status ?? 200, {
      "content-type": "application/json",
      ...(answer.headers ?? {}),
    });
    res.end(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}
```

- [ ] **Step 2: Write the failing integration test**

`tests/integration/mcp-directory-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { McpDirectory } from "../../server/features/mcp-directory/client.js";
import { Preferences } from "../../server/features/settings/preferences.js";
import { mcpDirectoryRoutes } from "../../server/http/routes/mcp-directory.js";
import { workspaceRoutes } from "../../server/http/routes/workspace.js";
import { registerResponses } from "../../server/http/responses.js";
import { fakeRegistry } from "../helpers/fake-mcp-registry.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

async function app(t, registry) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-directory-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const preferences = new Preferences({ dataDir, home: dataDir });
  await preferences.update({ mcpDirectory: { baseUrl: registry.baseUrl } });
  const mcpDirectory = new McpDirectory({
    settings: () => preferences.get().mcpDirectory,
    log: () => {},
    deadlineMs: 300,
  });
  const services = { preferences, mcpDirectory };
  const application = express();
  application.use(express.json());
  application.use("/api", mcpDirectoryRoutes(services));
  application.use(
    "/api",
    workspaceRoutes({
      ...services,
      config: { home: dataDir, dataDir },
      tools: () => [],
      accounts: { list: () => [] },
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
  return { request, preferences };
}

test("search, detail and status go through the configured registry", async (t) => {
  const registry = await fakeRegistry(t, {
    "/v0.1/servers": () => ({
      body: { servers: [fixture("opnsense"), fixture("deleted")], metadata: {} },
    }),
    "/v0.1/servers/io.github.example%2Fopnsense-mcp-server/versions/latest": () => ({
      body: fixture("opnsense"),
    }),
    "/v0.1/health": () => ({ body: { status: "ok" } }),
  });
  const { request } = await app(t, registry);
  const status = await request("GET", "/api/mcp-directory/status");
  assert.deepEqual(status.body, {
    enabled: true,
    host: new URL(registry.baseUrl).host,
    reachable: true,
  });
  assert.equal(status.cache, "no-store");
  const list = await request("GET", "/api/mcp-directory/servers?search=OPNsense");
  assert.deepEqual(
    list.body.entries.map((e) => e.name),
    ["io.github.example/opnsense-mcp-server"],
  );
  assert.equal(
    registry.requests.find((r) => r.path === "/v0.1/servers").query.search,
    "opnsense",
  );
  const detail = await request(
    "GET",
    `/api/mcp-directory/servers/${encodeURIComponent("io.github.example/opnsense-mcp-server")}`,
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.options[0].kind, "npm");
  for (const entry of registry.requests) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers.cookie, undefined);
  }
});

test("errors: 404, invalid detail, malformed JSON, oversize, timeout, redirect, 429 cache", async (t) => {
  let calls429 = 0;
  const registry = await fakeRegistry(t, {
    "/v0.1/servers/a.b%2Fmissing/versions/latest": () => ({ status: 404 }),
    "/v0.1/servers/a.b%2Finvalid/versions/latest": () => ({
      body: { server: { name: 3 } },
    }),
    "/v0.1/servers/a.b%2Fmalformed/versions/latest": () => ({ body: "{nope" }),
    "/v0.1/servers/a.b%2Fhuge/versions/latest": () => ({ body: "x".repeat(600 * 1024) }),
    "/v0.1/servers/a.b%2Fslow/versions/latest": () => ({ delay: 1000 }),
    "/v0.1/servers/a.b%2Fmoved/versions/latest": () => ({
      status: 302,
      headers: { location: "https://evil.test/" },
    }),
    "/v0.1/servers": () => {
      calls429 += 1;
      return { status: 429 };
    },
  });
  const { request } = await app(t, registry);
  const detail = (name) =>
    request("GET", `/api/mcp-directory/servers/${encodeURIComponent(`a.b/${name}`)}`);
  assert.deepEqual(
    [(await detail("missing")).status, (await detail("missing")).body.code],
    [404, "MCP_DIRECTORY_NOT_FOUND"],
  );
  assert.equal((await detail("invalid")).body.code, "MCP_DIRECTORY_INVALID");
  for (const name of ["malformed", "huge", "slow", "moved"]) {
    const answer = await detail(name);
    assert.deepEqual(
      [answer.status, answer.body.code],
      [503, "MCP_DIRECTORY_UNAVAILABLE"],
      name,
    );
  }
  await request("GET", "/api/mcp-directory/servers?search=a");
  await request("GET", "/api/mcp-directory/servers?search=a");
  assert.equal(calls429, 1);
});

test("the setting: validation, disabled 409, cache cleared on change", async (t) => {
  const registry = await fakeRegistry(t, {
    "/v0.1/servers": () => ({ body: { servers: [fixture("opnsense")], metadata: {} } }),
  });
  const { request } = await app(t, registry);
  for (const baseUrl of [
    "http://example.test",
    "https://u:p@x.test",
    "https://x.test/?q=1",
    5,
  ])
    assert.equal(
      (await request("PATCH", "/api/preferences", { mcpDirectory: { baseUrl } })).status,
      400,
      String(baseUrl),
    );
  assert.equal(
    (await request("PATCH", "/api/preferences", { mcpDirectory: { extra: 1 } })).status,
    400,
  );
  await request("GET", "/api/mcp-directory/servers?search=x");
  assert.equal(
    (await request("PATCH", "/api/preferences", { mcpDirectory: { enabled: false } }))
      .status,
    200,
  );
  const off = await request("GET", "/api/mcp-directory/servers?search=x");
  assert.deepEqual([off.status, off.body.code], [409, "MCP_DIRECTORY_DISABLED"]);
  await request("PATCH", "/api/preferences", { mcpDirectory: { enabled: true } });
  await request("GET", "/api/mcp-directory/servers?search=x");
  assert.equal(registry.requests.filter((r) => r.path === "/v0.1/servers").length, 2);
  const reset = await request("PATCH", "/api/preferences", {
    mcpDirectory: { baseUrl: null },
  });
  assert.equal(
    reset.body.mcpDirectory.baseUrl,
    "https://registry.modelcontextprotocol.io",
  );
});
```

`workspaceRoutes` only reads the services it uses when a request arrives; `PATCH /preferences` needs `preferences` and, optionally, `autoResume` and `mcpDirectory`.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/integration/mcp-directory-routes.test.js`
Expected: FAIL – route module missing.

- [ ] **Step 4: Implement**

`server/features/settings/preferences.js`: import `{ directorySettings, normaliseBaseUrl }` from `../mcp-directory/directory-settings.js`. In `get()` add `mcpDirectory: directorySettings(this.value.mcpDirectory)`. In `update(body)` allow the key `"mcpDirectory"` in the key check, then validate and merge:

```js
let mcpDirectory;
if (Object.hasOwn(body, "mcpDirectory")) {
  const change = body.mcpDirectory;
  if (
    !change ||
    typeof change !== "object" ||
    Array.isArray(change) ||
    Object.keys(change).some((key) => !["enabled", "baseUrl"].includes(key)) ||
    (Object.hasOwn(change, "enabled") && typeof change.enabled !== "boolean")
  )
    throw problem(serverMessages.settings.invalidPreferences);
  const current = directorySettings(this.value.mcpDirectory);
  mcpDirectory = {
    enabled: change.enabled ?? current.enabled,
    baseUrl:
      change.baseUrl === undefined
        ? current.baseUrl
        : change.baseUrl === null
          ? undefined
          : normaliseBaseUrl(change.baseUrl),
  };
}
```

and after the other merges: `if (mcpDirectory) next.mcpDirectory = mcpDirectory.baseUrl === undefined ? { enabled: mcpDirectory.enabled } : mcpDirectory;`.

`server/http/routes/workspace.js` in `router.patch("/preferences", …)`, after `preferences.update`:

```js
// A changed directory setting starts from an empty cache (another base, or off).
if (req.body?.mcpDirectory !== undefined) services.mcpDirectory?.clear();
```

`server/http/responses.js`: extend the code regex to `/^(?:SSH|ARTIFACT|PIPELINE|MCP_CLI|MCP_PACKAGE|MCP_DIRECTORY)_[A-Z_]+$/`.

`server/http/routes/mcp-directory.js`:

```js
import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";

/**
 * The read-only MCP directory: status for the Source card, search and one entry's
 * latest version. Answers are normalised DTOs; nothing here installs or writes.
 */
export function mcpDirectoryRoutes(services) {
  const directory = () => {
    if (!services.mcpDirectory) throw assistantProblem("unavailable", 503);
    return services.mcpDirectory;
  };
  const router = Router();
  router.use("/mcp-directory", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/mcp-directory/status", async (_req, res) =>
    res.json(await directory().status()),
  );
  router.get("/mcp-directory/servers", async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
    res.json(await directory().search({ search, cursor }));
  });
  router.get("/mcp-directory/servers/:name", async (req, res) =>
    res.json(await directory().detail(req.params.name)),
  );
  return router;
}
```

`server/application/services.js`: import `McpDirectory`; after `preferences` exists, create `const mcpDirectory = new McpDirectory({ settings: () => preferences.get().mcpDirectory });` and add `mcpDirectory` to the `services` object. `server/app.js`: import and `mount(mcpDirectoryRoutes(services));` after `mount(mcpCommandRoutes(services));`.

Update the exact `preferences.get()` expectations (`tests/integration/preferences.test.js` and any match of `grep -rn "autoResumeInterrupted: true" tests`) to include `mcpDirectory: { enabled: true, baseUrl: "https://registry.modelcontextprotocol.io" }`.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/integration/mcp-directory-routes.test.js tests/integration/preferences.test.js tests/unit/endpoint-routes-parity.test.js && npm run test:integration`
Expected: PASS (add the three routes to the parity list if it has one).

- [ ] **Step 6: Commit**

```bash
git add server tests/helpers/fake-mcp-registry.js tests/integration
git commit -m "feat: serve the MCP directory behind an owner setting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Messages and error codes

**Files:**

- Create: `server/lib/i18n/de/mcp-directory.js`, `server/lib/i18n/en/mcp-directory.js`, `server/features/mcp-directory/directory-errors.js`, `web/lib/i18n/en/mcp-directory.js`, `web/lib/i18n/de/mcp-directory.js`, `web/lib/i18n/messages/mcp-directory.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js`
- Test: `tests/unit/server-i18n-catalogs.test.js`, `tests/unit/i18n-catalogs.test.js`, new `tests/unit/mcp-directory-errors.test.js`

**Interfaces:**

- Produces: `serverMessages.mcpDirectory.{ disabled, unavailable, notFound, invalid, invalidRequest, invalidSettings }`; `directoryProblem(code) → Error & { status, code }` with statuses `DISABLED 409`, `UNAVAILABLE 503`, `NOT_FOUND 404`, `INVALID 502`, `INVALID_REQUEST 400`; `mcpDirectoryCopy` (web) with the settings-row keys below. PR 4 adds the directory screen keys to the same web catalog.

- [ ] **Step 1: Backend catalogs**

`server/lib/i18n/de/mcp-directory.js`:

```js
export const mcpDirectory = {
  disabled: "Das MCP-Verzeichnis ist ausgeschaltet.",
  unavailable:
    "Das Verzeichnis ist gerade nicht erreichbar. Versuch es noch einmal oder richte den Server anders ein.",
  notFound: "Diesen Eintrag gibt es im Verzeichnis nicht.",
  invalid: "Das Verzeichnis hat einen Eintrag geliefert, den AgentPier nicht lesen kann.",
  invalidRequest: "Ungültige Anfrage an das MCP-Verzeichnis.",
  invalidSettings:
    "Bitte eine https-Adresse ohne Zugangsdaten, Abfrage oder Fragment angeben (http nur auf diesem Rechner).",
};
```

`server/lib/i18n/en/mcp-directory.js`:

```js
export const mcpDirectory = {
  disabled: "The MCP directory is turned off.",
  unavailable:
    "The directory is not reachable right now. Try again, or set the server up another way.",
  notFound: "This entry is not in the directory.",
  invalid: "The directory returned an entry AgentPier cannot read.",
  invalidRequest: "Invalid request to the MCP directory.",
  invalidSettings:
    "Enter an https address without credentials, query or fragment (http only on this computer).",
};
```

Register both: `import { mcpDirectory } from "./de/mcp-directory.js";` / `"./en/mcp-directory.js"` and add `mcpDirectory,` to the exported objects in `catalog-de.js` and `catalog-en.js`.

- [ ] **Step 2: Error helper with its test**

`tests/unit/mcp-directory-errors.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { directoryProblem } from "../../server/features/mcp-directory/directory-errors.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";

test("each code has its status and a stable message key", () => {
  for (const [code, status, key] of [
    ["MCP_DIRECTORY_DISABLED", 409, "mcpDirectory.disabled"],
    ["MCP_DIRECTORY_UNAVAILABLE", 503, "mcpDirectory.unavailable"],
    ["MCP_DIRECTORY_NOT_FOUND", 404, "mcpDirectory.notFound"],
    ["MCP_DIRECTORY_INVALID", 502, "mcpDirectory.invalid"],
    ["MCP_DIRECTORY_INVALID_REQUEST", 400, "mcpDirectory.invalidRequest"],
  ]) {
    const error = directoryProblem(code);
    assert.deepEqual([error.code, error.status], [code, status]);
    assert.equal(messageIdentity(error.message).messageKey, key);
  }
  assert.throws(() => directoryProblem("NOPE"));
});
```

`server/features/mcp-directory/directory-errors.js`:

```js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const codes = {
  MCP_DIRECTORY_DISABLED: ["disabled", 409],
  MCP_DIRECTORY_UNAVAILABLE: ["unavailable", 503],
  MCP_DIRECTORY_NOT_FOUND: ["notFound", 404],
  MCP_DIRECTORY_INVALID: ["invalid", 502],
  MCP_DIRECTORY_INVALID_REQUEST: ["invalidRequest", 400],
};

/** A directory problem with its stable code; the message names no host or term. */
export function directoryProblem(code) {
  const known = codes[code];
  if (!known) throw Error(`Unknown directory code ${code}`);
  const [key, status] = known;
  return Object.assign(problem(serverMessages.mcpDirectory[key], status), { code });
}
```

The `routeProblem` mapping in `mcp-servers.js` does not apply here; `registerResponses` keeps a `status < 500`… note that `503` and `502` are ≥ 500: `responses.js` answers status 500 only as internal error; 502/503 keep their message (`status === 500` is the only rewrite), so the body carries the directory message and code.

- [ ] **Step 3: Web catalogs for the settings row**

`web/lib/i18n/en/mcp-directory.js`:

```js
export const mcpDirectoryCopy = {
  settingsTitle: "MCP directory",
  settingsLabel: "Search the MCP Registry",
  settingsHint:
    "Lets the MCP server wizard search the official MCP Registry. Searches go to the address below; nothing is installed without your confirmation.",
  advanced: "Advanced",
  baseUrlLabel: "Registry address",
  baseUrlHint: "An https address. http works only for a registry on this computer.",
  baseUrlInvalid:
    "Enter an https address without credentials, query or fragment (http only on this computer).",
  resetBaseUrl: "Use the official registry",
};
```

`web/lib/i18n/de/mcp-directory.js`:

```js
export const mcpDirectoryCopy = {
  settingsTitle: "MCP-Verzeichnis",
  settingsLabel: "Im MCP-Registry suchen",
  settingsHint:
    "Lässt die MCP-Server-Einrichtung im offiziellen MCP-Registry suchen. Suchen gehen an die Adresse unten; ohne deine Bestätigung wird nichts installiert.",
  advanced: "Erweitert",
  baseUrlLabel: "Registry-Adresse",
  baseUrlHint: "Eine https-Adresse. http geht nur für ein Registry auf diesem Rechner.",
  baseUrlInvalid:
    "Bitte eine https-Adresse ohne Zugangsdaten, Abfrage oder Fragment angeben (http nur auf diesem Rechner).",
  resetBaseUrl: "Offizielles Registry verwenden",
};
```

German copy never says "Assistent" (the catalogs test refuses it); the wizard is "MCP-Server-Einrichtung".

`web/lib/i18n/messages/mcp-directory.js`:

```js
import * as de from "../de/mcp-directory.js";
import * as en from "../en/mcp-directory.js";
import { localizedCopy } from "../index.js";
export const mcpDirectoryCopy = localizedCopy(de.mcpDirectoryCopy, en.mcpDirectoryCopy);
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/mcp-directory-errors.test.js tests/unit/server-i18n-catalogs.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/i18n server/features/mcp-directory/directory-errors.js web/lib/i18n tests/unit/mcp-directory-errors.test.js
git commit -m "feat: add MCP directory messages and error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Settings → Workspace row

**Files:**

- Create: `web/features/settings/McpDirectoryRow.jsx`, `tests/browser/mcp-directory-settings.spec.js`
- Modify: `web/features/settings/WorkspaceTab.jsx`, `web/features/settings/settings-steps.js`

**Interfaces:**

- Consumes: `state.mcpDirectory` (from `/api/state`, which spreads `preferences.get()`); `PATCH /api/preferences { mcpDirectory }`.
- Produces: the draft keys `mcpDirectoryEnabled: boolean`, `mcpDirectoryBaseUrl: string` in `WorkspaceTab`; the preferences step sends `{ mcpDirectory: { enabled, baseUrl } }` when either changed. PR 4's "Directory turned off" state links to `/settings?tab=workspace` (check the exact settings route with `grep -n "workspace" web/features/settings/settings-navigation.js`).

- [ ] **Step 1: Write the failing browser spec**

`tests/browser/mcp-directory-settings.spec.js` (uses `operationsFixture`, which serves `/api/state` and `PATCH /api/preferences` from `state.preferences`, as `settings-workspace.spec.js` does):

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsBar } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

const official = "https://registry.modelcontextprotocol.io";

async function setup(page) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const state = await operationsFixture(page);
  state.preferences = { mcpDirectory: { enabled: true, baseUrl: official } };
  // An address the server refuses (registered later, so it is asked first).
  await page.route("**/api/preferences", (route) =>
    route.request().postDataJSON()?.mcpDirectory?.baseUrl === "http://example.test"
      ? route.fulfill({
          status: 400,
          json: {
            code: "MCP_DIRECTORY_INVALID_SETTINGS",
            error:
              "Bitte eine https-Adresse ohne Zugangsdaten, Abfrage oder Fragment angeben (http nur auf diesem Rechner).",
            messageKey: "mcpDirectory.invalidSettings",
          },
        })
      : route.fallback(),
  );
  return state;
}
const patches = (state) =>
  state.calls.filter((call) => call.method === "PATCH" && call.path === "/preferences");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the directory can be turned off and pointed at another registry", async ({
      page,
    }) => {
      const state = await setup(page);
      await page.goto(`${baseURL}/settings`);
      const toggle = page.getByRole("switch", { name: "Search the MCP Registry" });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await page.getByText("Advanced", { exact: true }).click();
      await page.getByLabel("Registry address").fill("https://mirror.example.test/");
      await settingsBar(page).getByRole("button", { name: /^Save/ }).click();
      await expect.poll(() => patches(state).length).toBe(1);
      expect(patches(state)[0].body).toEqual({
        mcpDirectory: { enabled: false, baseUrl: "https://mirror.example.test/" },
      });
    });

    test("a refused address is named at the field in English", async ({ page }) => {
      await setup(page);
      await page.goto(`${baseURL}/settings`);
      await page.getByText("Advanced", { exact: true }).click();
      await page.getByLabel("Registry address").fill("http://example.test");
      await settingsBar(page).getByRole("button", { name: /^Save/ }).click();
      await expect(page.getByRole("alert")).toContainText(
        "Enter an https address without credentials",
      );
    });
  });
}
```

Run: `npm run build && npx playwright test tests/browser/mcp-directory-settings.spec.js`
Expected: FAIL – no such switch.

- [ ] **Step 2: The row**

`web/features/settings/McpDirectoryRow.jsx`:

```jsx
import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import { mcpDirectoryCopy as copy } from "../../lib/i18n/messages/mcp-directory.js";

const officialRegistry = "https://registry.modelcontextprotocol.io";

/** Settings → Workspace → MCP directory: on/off and the registry address. */
export default function McpDirectoryRow({ values, edit, error }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`}>
      <GroupLabel id={`${id}-title`}>{copy.settingsTitle}</GroupLabel>
      <ListCard labelledBy={`${id}-title`}>
        <ToggleRow
          label={copy.settingsLabel}
          hint={copy.settingsHint}
          checked={values.mcpDirectoryEnabled}
          onChange={edit("mcpDirectoryEnabled")}
        />
      </ListCard>
      <details className="settings-advanced" open={Boolean(error)}>
        <summary>{copy.advanced}</summary>
        <label htmlFor={`${id}-base`}>{copy.baseUrlLabel}</label>
        <input
          id={`${id}-base`}
          type="url"
          value={values.mcpDirectoryBaseUrl}
          maxLength={512}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => edit("mcpDirectoryBaseUrl")(event.target.value)}
        />
        <small
          id={`${id}-hint`}
          className={error ? "field-error" : "settings-hint"}
          role={error ? "alert" : undefined}
        >
          {error || copy.baseUrlHint}
        </small>
        {values.mcpDirectoryBaseUrl !== officialRegistry && (
          <button
            type="button"
            className="button text"
            onClick={() => edit("mcpDirectoryBaseUrl")(officialRegistry)}
          >
            {copy.resetBaseUrl}
          </button>
        )}
      </details>
    </section>
  );
}
```

- [ ] **Step 3: Wire it into the tab**

`WorkspaceTab.jsx`: extend `server` with

```js
    mcpDirectoryEnabled: state.mcpDirectory?.enabled !== false,
    mcpDirectoryBaseUrl: state.mcpDirectory?.baseUrl ?? "https://registry.modelcontextprotocol.io",
```

render `<McpDirectoryRow values={draft.values} edit={edit} error={directoryError} />` after the "General" group, where `directoryError` is the preferences step's refusal when its `messageKey` is `mcpDirectory.invalidSettings` (read it from `draft.outcome?.error` the way the tab reads other step errors; show it at the field and drop it from the bar).

`settings-steps.js`: in `preferencesStep`, after the generic `body` is built, add the directory part:

```js
const directoryKeys = ["mcpDirectoryEnabled", "mcpDirectoryBaseUrl"];
if (directoryKeys.some((key) => changed.includes(key)))
  body.mcpDirectory = {
    enabled: values.mcpDirectoryEnabled,
    baseUrl: values.mcpDirectoryBaseUrl.trim(),
  };
```

and add the two keys to the step's `keys` (`[...preferenceKeys, ...directoryKeys]`) so a change marks the step dirty.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx playwright test tests/browser/mcp-directory-settings.spec.js tests/browser/settings-*.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/settings tests/browser/mcp-directory-settings.spec.js
git commit -m "feat: turn the MCP directory on or off in Settings → Workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation, checks and PR

**Files:**

- Modify: `docs/mcp.md`, the doc that lists Settings → Workspace rows (find with `grep -rln "Settings → Workspace" docs README.md`)
- Delete: `docs/superpowers/plans/2026-10-16-mcp-wizard-3-directory-backend.md`

- [ ] **Step 1: Document**

Add to `docs/mcp.md` a subsection "MCP directory" under "Central MCP servers in the coding CLIs":

```markdown
### MCP directory

**Settings → Workspace → MCP directory** lets AgentPier search the official
[MCP Registry](https://registry.modelcontextprotocol.io) on demand (on by default). The
AgentPier server sends only the search term or the entry name to the configured
registry address (`https://` only; `http://` for a registry on this computer), keeps
answers for an hour in memory and never syncs, prefetches or installs anything. Entries
are checked and shortened before the browser sees them; links are shown as text and
open with `noopener noreferrer`. A directory listing is not a security review.
`GET /api/mcp-directory/status`, `/api/mcp-directory/servers?search=` and
`/api/mcp-directory/servers/:name` answer `409 MCP_DIRECTORY_DISABLED` while it is off
and `503 MCP_DIRECTORY_UNAVAILABLE` when the registry cannot be reached.
```

Add the row to the Settings → Workspace description where rows are listed.

- [ ] **Step 2: Full verification**

Run: `npm run check && npm run build && npx playwright test tests/browser/mcp-directory-settings.spec.js`
Expected: PASS.

- [ ] **Step 3: Remove the plan, commit, push, PR**

```bash
git rm docs/superpowers/plans/2026-10-16-mcp-wizard-3-directory-backend.md
git add docs
git commit -m "docs: describe the MCP directory setting and endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch -q origin && git rebase origin/main
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push -q -u origin feat/mcp-directory-backend
```

PR title: `feat: add an on-demand MCP Registry directory behind a setting`. Describe AGENTPIER-83, the endpoints, limits and privacy (search term only, host named, no background traffic), validation, docs checked, screenshot of the settings row; end with the Claude Code line.

---

## Self-Review

1. **Spec coverage (stage 2a).** Endpoints (Tasks 4–5), cache and keys (Task 3), settings + validation + clear on change (Tasks 1, 5), untrusted data validation and caps (Task 2), offline/errors and logging (Tasks 4, 6), never auto-install (no write paths exist), Settings → Workspace row (Task 7), docs (Task 8). The directory UI, `origin` column and update pill are PR 4.
2. **Placeholders.** None. The `oversize.json` fixture is generated by the one-line script shown in Task 2 to keep the 150/400/600-character strings out of review.
3. **Type consistency.** `Entry`/`Option`/`Input`/`Variable` (Task 2) are what PR 4 renders; error codes match between Tasks 4, 5 and 6.
4. **Known limits.** A restore keeps only `defaultCwd` and `defaultAccountIds` from `preferences.json` (`restore-data.js`), so the directory setting returns to its default after a restore, like `autoResumeInterrupted` today.
