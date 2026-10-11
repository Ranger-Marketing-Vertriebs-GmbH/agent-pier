# Agent capability profiles: web, browser and documents

Status: agreed design. Plane: AGENTPIER-24 (step 2 of AGENTPIER-21).

Date: 2026-10-11

## Goal

The owner can give each agent native OpenClaw tools from the agent settings: web
search, web fetch, an isolated browser, and reading PDFs and images. Everything is
off by default. A global setting chooses the web search provider.

## Current state

- An assistant's `capabilities` are exactly `{ memory, reminders }`
  (`assistant-validation.js`); other keys are rejected.
- `profileTools` (`native-capabilities.js`) builds each agent's tool list;
  `agentEntry` writes it to `agents.entries.<id>.tools.allow` on start and live.
- `compileOpenClawConfig` (`runtime-config.js`) rewrites the global `tools` block
  on every start; OpenClaw only narrows per layer, so a tool must be allowed
  globally and per agent. `tools`, `browser` and `plugins` are locked paths.
- The browser is forced off (`hardenedDefaults().browser`). AgentPier provisions no
  browser; `playwright-core` is in the qualified runtime lock.
- Team members have no capability fields; `personalCapabilities` grants memory and
  reminders to personal agents and permanent members only.

## Decisions

| Capability | Tool                | Rule                                                                                                                                                                      |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web search | `web_search`        | Provider from the global setting                                                                                                                                          |
| Web fetch  | `web_fetch`         | Private network addresses blocked (`tools.web.fetch.ssrfPolicy`)                                                                                                          |
| Browser    | `browser`           | Only the isolated `openclaw` profile; the `user` profile (signed-in Chrome) is never configured; `evaluateEnabled: false`; private network blocked (`browser.ssrfPolicy`) |
| Documents  | `pdf`, `view_image` | Uses the agent's model                                                                                                                                                    |

Not in this step: image generation and speech output. They need provider plugins
(OpenAI, Google, ElevenLabs and others) that AgentPier's model connections do not
cover; a separate backlog item tracks them.

### Eligibility

New capabilities follow `personalCapabilities`: personal agents and permanent team
members, never archived agents. Temporary team members get none of them in this
step; the team write guard covers only `write` and `edit`, and there is no member
permission model yet.

### Web search provider

A global setting next to the speech settings:

- **DuckDuckGo** (default): no key.
- **Perplexity**: uses the key of an existing OpenRouter connection chosen by the
  owner.
- **Brave**: an own API key stored in the backend.

Keys never reach the browser. The compiled configuration selects the provider
(`tools.web.search.provider`) and supplies its key the way OpenClaw expects; the
exact keys (plugin config or environment variable) are verified live in the first
task.

### Browser availability

AgentPier detects an installed Chromium-based browser (Chrome, Brave, Edge,
Chromium) in the standard locations of macOS and Linux. Without one, the browser
switch is disabled and explains what is missing. AgentPier installs nothing; when a
browser is found, its path is set explicitly (`browser.executablePath`), because the
Gateway runs with a private `HOME`.

## Architecture

- **Data:** `capabilities` gains `webSearch`, `webFetch`, `browser` and `documents`
  (booleans, default false). Validation accepts the extended object; stored records
  without the new keys read as false.
- **Tools:** `profileTools` adds the granted tools for eligible agents.
  `compileOpenClawConfig` adds a tool to the global allow list only when at least one
  eligible agent has it, and writes `tools.web`, `browser` and the search provider
  configuration only then. Every path stays in the locked core and is computed from
  profiles and settings, never from owner overrides.
- **Settings storage:** the search provider choice and a Brave key live in their own
  backend store with an owner route, like the speech settings.
- **Live changes:** saving an agent applies its entry through the existing live
  path. A change that needs a new global tool, browser or provider configuration
  also patches those paths with `patchConfig`; a path that needs a restart (per
  `config.schema.lookup`) is reported to the owner.
- **UI:** new switches in the agent settings with short explanations, a disabled
  browser switch with the reason when no browser is found, and the search provider
  setting. German and English, usable at phone width.

## Teams

- Team plugin, team tools and the write guard stay as they are.
- Temporary team members receive none of the new tools.
- Team contract and qualification tests must pass.

## Testing

- Unit: validation of the extended capabilities; `profileTools` per eligibility;
  compiled configuration with and without agents using each tool (global allow,
  `tools.web`, `browser` block with `openclaw` profile only, `evaluateEnabled`,
  SSRF policies, provider selection); browser detection with fake paths.
- Browser (Playwright): agent settings switches and saved state, disabled browser
  switch, search provider setting; German and English; phone width.
- Live contract (extends `assistant-native-interfaces-contract.test.js`): an agent
  with web fetch fetches a local test page, private addresses are refused;
  DuckDuckGo search is configured and the tool is offered; the browser opens a
  local page in the `openclaw` profile when a browser is installed (skipped with a
  recorded reason otherwise).
- Existing assistant and team tests unchanged.

## Out of scope

Image generation, speech output, shell, skills, MCP, team member permissions,
installing a browser.
