# Web tools and browser qualification

The web tools test in the native interfaces contract checks the OpenClaw 2026.9.8
configuration for `web_search`, `web_fetch`, `browser`, `pdf` and `view_image`. It
runs a real isolated Gateway started by `RuntimeSupervisor`, writes the
configuration through `patchConfig`, and has the deterministic model from
`tests/helpers/assistant-model-server.js` call each tool once. No search API,
model account or credential is involved. The page that the tools try to reach is
a local HTTP server on `127.0.0.1`.

The findings about the external search plugins come from separate manual probes.
They were run against the same isolated runtime and the official 2026.9.8 plugin
tarballs. The contract does not repeat them, because the pinned runtime does not
include these plugins.

## Running the contract

```sh
AGENTPIER_NATIVE_INTERFACES_CONTRACT_RUNTIME=/absolute/path/to/2026.9.8-node26.7.0-darwin-arm64 \
AGENTPIER_TEST_BROWSER_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node --test tests/integration/assistant-native-interfaces-contract.test.js
```

Without `AGENTPIER_TEST_BROWSER_PATH`, the test looks for
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/chromium`
and `/usr/bin/google-chrome`. If it finds none, it skips only the browser subtest.
The browser always runs headless, with its profile in the test's temporary
`HOME`. It never opens the user's Chrome profile.

On 2026-10-11, all tests in the file passed on macOS arm64 (Darwin 25.5) against the
pinned `2026.9.8-node26.7.0-darwin-arm64` runtime and Google Chrome, with zero
skips or failures.

## Verified configuration

### (a) DuckDuckGo

DuckDuckGo, Perplexity and Brave are **not bundled** in OpenClaw 2026.9.8. They are
official external plugins: `@openclaw/duckduckgo-plugin`,
`@openclaw/perplexity-plugin` and `@openclaw/brave-plugin`. Version `2026.9.8`
exists for each on npm, with peer dependency `openclaw >=2026.9.8`. Each package
has no runtime dependencies and imports only `openclaw/plugin-sdk/*`. The bundled
web search providers are `gemini` (google), `grok` (xai), `minimax` and `ollama`.

Without the plugin, `config.patch` rejects
`tools.web.search.provider: "duckduckgo"` with `INVALID_REQUEST`:
`web_search provider is not available: duckduckgo (install or enable plugin
"duckduckgo" ...)`. The issue lists the allowed values `brave`, `duckduckgo`,
`exa`, `firecrawl`, `firecrawl-free`, `gemini`, `grok`, `kimi`, `minimax`,
`ollama`, `parallel`, `parallel-free`, `perplexity`, `searxng` and `tavily`. The
contract asserts this rejection.

With the unpacked package directory in `plugins.load.paths`, the provider is
accepted and `web_search` returns DuckDuckGo results (probe). The plugin shows up in
`plugins.list` with `origin: "config"` and `runtime.state: "active"`:

```json5
{
  plugins: {
    allow: [/* existing entries */ "duckduckgo"],
    load: { paths: ["<dir>/duckduckgo-plugin/package"] },
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
    load: { paths: ["<dir>/perplexity-plugin/package"] },
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

Private targets are blocked by default. The contract sets
`{ dangerouslyAllowPrivateNetwork: false }` and asserts that
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
  `localhost` and `10.0.0.0/8` with `browser navigation blocked by policy`. Do not
  set `dangerouslyAllowPrivateNetwork: false` explicitly. That switches the policy
  into strict mode, which needs Playwright to inspect redirects. Local managed
  profiles do not have that, so every `http(s)` navigation fails with
  `strict browser SSRF policy requires Playwright-backed redirect-hop
inspection`. `allowedHostnames: ["127.0.0.1"]` allows a host on its own. The
  contract uses this to open a local page and read its marker from a snapshot.
- **Isolation.** The `openclaw` profile keeps its data in
  `<state>/browser/openclaw/user-data` inside the Gateway's data directory, which
  the contract asserts. `action: "stop"` ends Chrome. `headless: true` keeps a
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

- The contract does not load the external search plugins. Tasks that enable search
  must add them to the runtime installation and its update path, and extend this
  contract to cover them.
- No real search API was called. One probe incidentally ran a real DuckDuckGo
  search, which is not repeated.
- The Perplexity key and transport were verified through configuration acceptance
  and the plugin source, not with a request.
- Linux Chrome runs headless without `noSandbox`. CI runners with
  `/usr/bin/google-chrome` will run the browser subtest; on Linux, the sandbox may
  need checking.
- The browser plugin's bundled `browser-automation` skill is skipped in the
  temporary data directory (`symlink prefix resolves outside the root ancestry`).
