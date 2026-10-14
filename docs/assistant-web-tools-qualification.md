# Web tools and browser qualification

Two opt-in contracts check how OpenClaw 2026.9.8 serves `web_search`, `web_fetch`,
`browser` and `view_image` (and shows why `pdf` is not offered) with the configuration AgentPier writes. Both run
a real isolated Gateway started by `RuntimeSupervisor` in a temporary data
directory. The deterministic model from `tests/helpers/assistant-model-server.js`
calls each tool once. No search API, model account or credential is involved, and
every page the tools try to reach is a local HTTP server on `127.0.0.1`.

- `tests/integration/assistant-web-tools-contract.test.js` loads each bundled search
  plugin from the installed runtime and checks that its provider is accepted.
- `tests/integration/assistant-web-tools-compiled-contract.test.js` starts the
  Gateway from the **compiled** startup configuration in team mode and checks what
  the agents are actually offered (see [compiled configuration](#compiled-configuration-in-team-mode)).

The external search plugins are part of the managed runtime's locked dependency
graph (see [runtime updates](assistant-runtime-updates.md#bundled-search-plugins)).
Some details below (search results, the Brave request, the reload kinds) come from
manual probes against the official 2026.9.8 plugin tarballs and from the earlier
hand-patched contract; the contracts do not repeat them.

## Running the contracts

Both need a runtime provisioned from the current lock (directory name ending in
`-lock563cf3904093` or later). `scripts/provision-assistant-contracts.mjs` writes
the variables, including `AGENTPIER_ASSISTANT_CONTRACT_DIR`, into an env file.
Node intercepts `--env-file` itself, so locally the file must exist first:

```sh
touch /tmp/contracts.env
node scripts/provision-assistant-contracts.mjs --data-dir /tmp/agentpier-contracts --env-file /tmp/contracts.env
set -a; . /tmp/contracts.env; set +a
node --test --test-concurrency=1 \
  tests/integration/assistant-web-tools-contract.test.js \
  tests/integration/assistant-web-tools-compiled-contract.test.js
```

The compiled contract reads the search plugins from the provisioned installation's
runtime descriptor (`selectedAssistantRuntime()` on
`AGENTPIER_ASSISTANT_CONTRACT_DIR`), never from a hand-built path, and provisions the
team plugin into its own temporary data directory. It uses AgentPier's
`detectBrowser()` unless `AGENTPIER_TEST_BROWSER_PATH` names a browser. Without a
browser it skips only the browser subtest; with `CI` set it fails instead, because
the `native-contracts` job requires zero skips. The browser always runs headless,
with its profile below the test's temporary data directory. It never opens the
user's Chrome profile.

### Continuous integration

The `native-contracts` job (`.github/workflows/assistant-runtime.yml`) exports
`AGENTPIER_TEST_BROWSER_PATH` from the runner's preinstalled Google Chrome
(`/usr/bin/google-chrome` on `ubuntu-latest`,
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on `macos-latest`)
and fails that step when neither exists.

AgentPier never compiles `browser.noSandbox`. The Chrome package on the Ubuntu
runners installs the setuid `chrome-sandbox` helper, so Chrome's sandbox should
start even where AppArmor restricts unprivileged user namespaces, and the job runs
as a regular user, not root. **This is an assumption that has not been verified on
a hosted runner.** If the Linux job fails with `No usable sandbox`, set
`AGENTPIER_TEST_BROWSER_NO_SANDBOX=1` for that job only: the contract then adds
`noSandbox` to its own startup file in `beforeSpawn`, never to AgentPier's
compiled configuration.

## Compiled configuration in team mode

On 2026-10-11 the compiled contract passed on macOS arm64 (Darwin 25.5) against a
fresh `2026.9.8-node26.7.0-darwin-arm64-lock563cf3904093` runtime and Google Chrome
(2 tests including the browser subtest, 0 skips, 0 failures). The setup uses the
real code paths: `AssistantStore` profiles, `WebSearchSettings` (default
DuckDuckGo), the runtime descriptor's `searchPlugins`, `TeamBridge`, the team
plugin, and `AssistantConfig.apply` for the agent entries. After the entries are
applied, the Gateway restarts so that they also come from the startup compile.

- **One agent with every capability** (memory, reminders, web search, web fetch,
  browser, documents) and **one temporary team member** with every capability
  recorded.
- **The Gateway accepts the compiled startup configuration** under the restrictive
  team allow list: `plugins.allow` is exactly
  `["agentpier-teams", "memory-core", "duckduckgo", "browser"]`,
  `plugins.load.paths` is the team plugin and the DuckDuckGo package from the
  descriptor, and `plugins.list` reports all four `active`. DuckDuckGo carries no
  key. `tools.web` is `{ search: { provider: "duckduckgo" }, fetch: { ssrfPolicy:
{ dangerouslyAllowPrivateNetwork: false } } }`, and the root `browser` block equals
  `webToolsSections` for the running port.
- **The agent** is granted `web_search`, `web_fetch`, `browser` and
  `view_image` (the Read images switch no longer grants `pdf`), and is offered
  `web_search`, `web_fetch`, `browser` and `view_image`. `web_search` is not called (no real search). `web_fetch` of the
  loopback page fails with `Blocked hostname or private/internal/special-use IP
address`; the page receives no request.
- **`pdf` is not granted by AgentPier and not offered.** OpenClaw offers `pdf` for a custom provider
  only when `agents.defaults.pdfModel` (or `imageModel`) names a model. AgentPier
  compiles neither, and a per-agent `pdfModel` in `agents.entries.<id>` is rejected
  with `INVALID_REQUEST`; a probe with `agents.defaults.pdfModel` made `pdf`
  appear. The contract asserts that `pdf` stays not offered; a global `pdfModel` is tracked separately.
- **The temporary member** gets only `session_status` and `agentpier_workspace`: no
  capability tool in its entry and none offered to the model, so its `web_fetch`
  request cannot run.
- **Browser:** `status` reports the `openclaw` profile and driver with the detected
  executable. `profiles` lists `chrome`, `openclaw` and `user`, all with driver
  `openclaw`. `importprofile` answers `system profile import is disabled`. `open` on
  the loopback page answers `browser navigation blocked by policy`. `start` launches
  Chrome, whose `userDataDir` lies inside the test's data directory, and `stop` ends
  it.

This contract replaced an earlier hand-patched web tools test in the native
interfaces contract. Its additional findings (the
reload kinds and the `allowedHostnames` page snapshot) remain recorded below.

### Search plugins one at a time

For each of `duckduckgo`, `perplexity` and `brave`, the search plugin contract
checks the installed package version and plugin id, asserts that
`tools.web.search.provider` is rejected while the plugin is not loaded, then loads
it with `plugins.load.paths` (the package directory under
`app/node_modules/@openclaw/`) and `plugins.allow: [<id>]`. The provider is then
accepted, `plugins.list` reports the pinned package and version with
`origin: "config"` and `runtime.state: "active"`, and a fixture key in
`plugins.entries.<id>.config.webSearch.apiKey` (Perplexity, Brave) is redacted by
`config.get`. It passed on 2026-10-11 against the same runtime.

On 2026-10-14 both contracts also passed on macOS arm64 against OpenClaw 2026.10.3
with the 2026.10.3 search plugins, as part of the `native-contracts` run recorded in
the [release qualification](assistant-release-qualification.md#openclaw-202699--2026103-2026-10-14).

## Verified configuration

### (a) DuckDuckGo

DuckDuckGo, Perplexity and Brave are **not bundled** in OpenClaw 2026.9.8 or 2026.9.9. They are
official external plugins: `@openclaw/duckduckgo-plugin`,
`@openclaw/perplexity-plugin` and `@openclaw/brave-plugin`. Each is published at the
OpenClaw version, with peer dependency `openclaw >=<that version>` (pinned:
`2026.10.3`; the `2026.9.9` packages differed from `2026.9.8` only in version
metadata). Each package
has no runtime dependencies and imports only `openclaw/plugin-sdk/*`. The bundled
web search providers are `gemini` (google), `grok` (xai), `minimax` and `ollama`.

Without the plugin, `config.patch` rejects
`tools.web.search.provider: "duckduckgo"` with `INVALID_REQUEST`:
`web_search provider is not available: duckduckgo (install or enable plugin
"duckduckgo" ...)`. The issue lists the allowed values `brave`, `duckduckgo`,
`exa`, `firecrawl`, `firecrawl-free`, `gemini`, `grok`, `kimi`, `minimax`,
`ollama`, `parallel`, `parallel-free`, `perplexity`, `searxng` and `tavily`. The
contract asserts this rejection.

With the package directory in `plugins.load.paths`, the provider is
accepted and `web_search` returns DuckDuckGo results (probe). The plugin shows up in
`plugins.list` with `origin: "config"` and `runtime.state: "active"`:

```json5
{
  plugins: {
    allow: [/* existing entries */ "duckduckgo"],
    load: { paths: ["<runtime>/app/node_modules/@openclaw/duckduckgo-plugin"] },
  },
  tools: { web: { search: { provider: "duckduckgo" } } },
}
```

Optional: `plugins.entries.duckduckgo.config.webSearch.{region, safeSearch}`
(`safeSearch` is `strict`, `moderate` or `off`).

If `tools.allow` contains `web_search` but no provider is available, the tool is
still offered. Calling it then returns `web_search is disabled or no provider is
available.` So AgentPier should allow `web_search` only together with a loaded
provider.

### (b) Perplexity (OpenRouter key)

The key goes in `plugins.entries.perplexity.config.webSearch.apiKey`. Its schema type
is `["string", "object"]`, so a SecretRef also works, and its hint is
`sensitive: true`. `config.get` returns the value as `__OPENCLAW_REDACTED__`.
Optional keys are `webSearch.baseUrl` and `webSearch.model`. With the plugin
loaded, an `sk-or-...` key plus `provider: "perplexity"` is accepted.

Per the plugin source, a configured `sk-or-` key selects the chat-completions
transport with base URL `https://openrouter.ai/api/v1` and model
`perplexity/sonar-pro`. Searches are billed to the OpenRouter account. This path
does not support `max_tokens`, `max_tokens_per_page` and other native Search API
filters.

The plugin also reads the environment variables `PERPLEXITY_API_KEY` and
`OPENROUTER_API_KEY`. `runtimeEnvironment` passes neither to the Gateway, so
AgentPier should use the plugin configuration.

The end-to-end request could not be tested locally. A local `baseUrl` did not
receive a request, presumably because the plugin's trusted endpoint guard blocks
loopback hosts, so the tool returned `provider_error`.

```json5
{
  plugins: {
    allow: [/* ... */ "perplexity"],
    load: { paths: ["<runtime>/app/node_modules/@openclaw/perplexity-plugin"] },
    entries: { perplexity: { config: { webSearch: { apiKey: "<openrouter key>" } } } },
  },
  tools: { web: { search: { provider: "perplexity" } } },
}
```

### (c) Brave

The key goes in `plugins.entries.brave.config.webSearch.apiKey` (string or
SecretRef, `sensitive: true`, redacted by `config.get`). The plugin also reads the
`BRAVE_API_KEY` environment variable, which `runtimeEnvironment` does not pass.
Optional keys are `webSearch.mode` (`web` or `llm-context`) and `webSearch.baseUrl`.

This was verified end to end against a local fake with `baseUrl` set to
`http://127.0.0.1:<port>`. The plugin sent
`GET /res/v1/web/search?q=...&count=5` with header
`X-Subscription-Token: <configured key>`, and `web_search` returned the fake result.
Setting `provider: "brave"` without a key is also accepted. The configuration has
the same shape as (b), with `brave` in place of `perplexity`.

### (d) Web fetch SSRF policy

`tools.web.fetch.ssrfPolicy` accepts these keys:

- `dangerouslyAllowPrivateNetwork`
- `allowRfc2544BenchmarkRange`
- `allowIpv6UniqueLocalRange`
- `allowedHostnames`
- `blockedHostnames`

Private targets are blocked by default. AgentPier compiles
`{ dangerouslyAllowPrivateNetwork: false }`, and the compiled contract asserts that
`web_fetch http://127.0.0.1:<port>/` fails before any request reaches the server.
The tool result has `status: "error"` and contains
`Blocked hostname or private/internal/special-use IP address`. In a probe, the same
explicit `false` still fetched `https://example.com/`.

### (e) Browser

The verified block:

```json5
browser: {
  enabled: true,
  defaultProfile: "openclaw",
  evaluateEnabled: false,
  allowSystemProfileImport: false,
  headless: true,
  executablePath: "<detected Chromium-based browser>",
  profiles: {
    user: { driver: "openclaw", cdpPort: gatewayPort + 12 },
    chrome: { driver: "openclaw", cdpPort: gatewayPort + 13 },
  },
  // ssrfPolicy: omit, or only allowedHostnames/blockedHostnames
}
```

Findings:

- **Implicit `user` and `chrome` profiles.** The bundled plugin always adds a
  `user` profile (`driver: "existing-session"`, which attaches to the signed-in
  Chrome through Chrome DevTools MCP) and a `chrome` profile
  (`driver: "extension"`). This happens unless the configuration defines profiles
  with these names. The model can select either one with `profile: "user"`. Without
  the override, `action: "status", profile: "user"` reported `running: true`.
  Redefining both as managed `openclaw` profiles on their own CDP ports removes the
  path to the user's browser. OpenClaw derives the CDP range from the Gateway port:
  control port = `gatewayPort + 2`, first CDP port = `gatewayPort + 11`. The
  contract asserts that every listed profile has `driver: "openclaw"`.
- **`allowSystemProfileImport: false`.** The tool exposes `action: "importprofile"`,
  which copies cookies from a macOS Chrome-family system profile. With the flag set
  to `false`, the tool answers `system profile import is disabled`, as the contract
  asserts.
- **`ssrfPolicy`.** The default (no `ssrfPolicy`) already blocks `127.0.0.1`,
  `localhost` and `10.0.0.0/8` with `browser navigation blocked by policy`, which the
  compiled contract asserts. Do not
  set `dangerouslyAllowPrivateNetwork: false` explicitly. That switches the policy
  into strict mode, which needs Playwright to inspect redirects. Local managed
  profiles do not have that, so every `http(s)` navigation fails with
  `strict browser SSRF policy requires Playwright-backed redirect-hop
inspection`. `allowedHostnames: ["127.0.0.1"]` allows a host on its own; a
  hand-patched probe used this to open a local page and read its marker from a
  snapshot. AgentPier compiles no `ssrfPolicy`.
- **Isolation.** The `openclaw` profile keeps its data in
  `<state>/browser/openclaw/user-data` inside the Gateway's data directory, which
  the compiled contract asserts. `action: "stop"` ends Chrome. `headless: true` keeps a
  window from appearing on the desktop. Without it, macOS launches a visible
  window.
- **`plugins.allow`.** An explicit root `browser` block activates the bundled
  browser plugin even under a restrictive `plugins.allow`. This was verified at
  startup with `allow: ["memory-core"]`, where `browser` was offered and answered.
  A plugin from `plugins.load.paths` was also active without an allow entry. Adding
  `browser` and the search plugin id to `allow` is still recommended: it is
  explicit, and it silences the warning
  `OpenClaw can't verify where this plugin came from`.
- **`evaluateEnabled: false`** is accepted and stored. The tool schema does not
  offer `act` with `kind: "evaluate"`, so the call fails validation.
- **Documents.** `pdf` and `view_image` appear only when the model can take images
  (`input: ["text", "image"]`). The custom fixture provider also needs
  `agents.defaults.pdfModel` (or `imageModel`) before `pdf` is offered.

### (f) Reload kinds

`config.schema.lookup` reports `reloadKind: "hot"` for these paths:

- `tools.web.search.provider`, `tools.web.search.enabled`,
  `tools.web.search.maxResults`
- `tools.web.fetch` and all its children, including `ssrfPolicy.*`
- `browser.enabled`, `browser.executablePath`, `browser.defaultProfile`,
  `browser.evaluateEnabled`, `browser.allowSystemProfileImport`,
  `browser.headless`, `browser.profiles`, `browser.ssrfPolicy.*`
- `plugins.allow`, `plugins.load.paths`, `plugins.entries.*`, including each
  provider's `config.webSearch.*`
- `tools.allow`, `agents.defaults.pdfModel`

The lookup is not the whole story:

- With no `plugins.allow` (AgentPier's default configuration), live patches of the
  browser block and of `plugins.load.paths` take effect without a restart.
- Under a restrictive `plugins.allow` (AgentPier's team configuration), a live patch
  that enables the browser (`browser.enabled`, `browser.headless`,
  `browser.executablePath`) logs `config change requires gateway restart`. The next
  `config.patch` then fails with `UNAVAILABLE`: `config.patch persisted ..., but a
recovery restart is required`. The Gateway restarts, and `RuntimeSupervisor`
  recompiles the configuration.
- Once the browser is active from startup, a live change of `browser.ssrfPolicy`
  stays hot.

AgentPier should therefore compile these sections into the startup configuration
and restart the Gateway when they change, rather than relying on live patches.

## Boundaries

- The combination of a search plugin and the browser with the team plugin's
  restrictive allow list is covered for DuckDuckGo only. Perplexity and Brave are
  covered one at a time without the team allow list; their compiled form differs
  only by the key entry.
- A runtime installed before the plugins were bundled (lock `93bd048153fd`, or a
  2026.9.7 installation, which is no longer a rollback target) has none; its descriptor reports `searchPlugins: {}`
  and AgentPier withholds web search.
- No real search API was called. One early probe incidentally ran a real DuckDuckGo
  search, which is not repeated.
- The Perplexity key and transport were verified through configuration acceptance
  and the plugin source, not with a request.
- `pdf` is not offered with AgentPier's custom providers (see above).
- Headless Linux Chrome without `noSandbox` is unverified on hosted runners (see
  [continuous integration](#continuous-integration)).
- The browser plugin's bundled `browser-automation` skill is skipped in the
  temporary data directory (`symlink prefix resolves outside the root ancestry`).
