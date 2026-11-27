# Model connections for managed assistants

Assistants use the existing central model connections. Configure a connection in
AgentPier's model provider settings, then select it in the assistant settings and
enter the exact configured model ID. Each assistant and team member can select its
own connection and model. Native ChatGPT account selection and OpenRouter remain
available through their existing paths.

| Connection                 | Central settings                                                                                | Assistant transport                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Ollama                     | Ollama preset; normally `http://127.0.0.1:11434/v1`                                             | Chat Completions streaming (Responses with an API key)         |
| llama.cpp                  | llama.cpp preset; normally `http://127.0.0.1:8080/v1`                                           | Chat Completions streaming                                     |
| Generic compatible service | Custom preset; service's API base URL                                                           | Chat Completions streaming (Responses when ticked, with a key) |
| Azure OpenAI / Foundry v1  | Azure OpenAI preset; `https://RESOURCE.openai.azure.com/openai/v1`; deployment name as model ID | Responses streaming                                            |

Enable the connection's Chat Completions protocol and configure each model's context
window (at least 4,000 tokens, the pinned runtime's hard minimum). A connection without
such a model is listed as unavailable ("Configure a model with at least 4,000 context
tokens"); the wizard and agent settings name it and link to the context field of its
first model that lacks one. Azure deployments always need this step: Azure reports no
context size. The configured
output limit is preserved; an omitted limit uses the central
connection's normal default (a quarter of context, capped at 32,000 tokens). Use a
model that supports streamed function calls for assistant tools. Configuring a
connection does not prove that the selected model can reason or use tools correctly.

With an API key and no custom authentication header, the key is sent as Bearer
authentication. The custom `api-key` header sends the raw key there and an empty
Authorization
header to suppress the SDK's default Bearer credential. A custom `Authorization`
header sends the raw configured value, which may include a prefix when required. For Azure,
the Azure OpenAI preset sets `api-key` as the custom authentication header; save the Azure API key.
The v1 URL does not require a dated `api-version` query parameter. Azure's model ID
is the deployment name, which can differ from the underlying model name. Pasting a
deployment's target URI into the base URL field keeps the v1 base URL and adds the
deployment as a model; base models from Azure's model list are never added.
See [Microsoft's v1 API documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle).

Keyless local connections use OpenClaw's native local authentication handling;
AgentPier does not create a fake key. Supported local hosts are localhost, loopback
addresses, RFC1918 IPv4 addresses, `.local` names, and the native runtime's Docker/Orb
host aliases. Public keyless endpoints are unavailable because the pinned runtime
requires credentials for them. URLs requiring query parameters, legacy Azure
`/deployments/...` APIs, automatic Entra token acquisition, and connections without
Chat Completions (Responses-only or Messages-only) are outside this adapter's supported
contract. Unsupported
catalog providers remain unavailable rather than silently selecting another account.
Arbitrary custom authentication headers (for example `X-Inference-Key`) are unavailable
when a key is configured: pinned OpenClaw 2026.9.8 and its OpenAI SDK cannot suppress
the implicit Bearer credential safely for those headers through supported configuration.
AgentPier reports `unsupportedAuthentication` instead of sending the key twice.

The connection lease blocks editing or removal while its configuration is being
resolved and applied. Subsequent resolution reads the current central credential.
Editing or removing a connection referenced by an assistant needs a Gateway restart.
A revocation (deleting the connection, a new key or removing its key) restarts it at
once: the request needs `confirmRestart: true`; without it the route answers 409
`ASSISTANT_RESTART_REQUIRED` and **Connections › Model access** asks for that confirmation. The
change then uses the shared runtime maintenance gate; active or uncertain work
prevents it, and the owned Gateway stops before central credentials change. Any
other change (for example the endpoint or the name) is saved at once and the restart
becomes [pending](assistant-gateway.md#pending-restart): it runs through the same
gate as soon as nothing is busy, or at once with **Restart now**. The restart
refreshes the managed provider/profile configuration before the Gateway starts
again. A runtime that was disabled remains disabled. A native account logout restarts at once and is
refused while active or uncertain work runs.
Changed transport settings or credentials receive a new native provider identity,
so the selected model cannot inherit obsolete keys or headers through native merging.
If the connection is removed or unusable, the profile receives a blocked model with
no fallbacks, then its reminders/routines are paused. The blocked selection prevents
native scheduled work from using an old credential even before pause completes.
Preparation repeats before every Gateway spawn, including automatic recovery.
Re-adding a working connection does not automatically resume paused schedules.
Superseded native model-cache entries may remain in private runtime storage; the
managed selection no longer references them.
Credential values remain in private runtime configuration and request transport;
capability responses expose model choices and stable availability reasons only.
OpenClaw owns request streaming, tool execution, and context handling. Its transport
configuration is documented in the [custom provider reference](https://docs.openclaw.ai/gateway/config-tools/custom-providers).

Agents call an endpoint connection directly through OpenClaw. A connection with an API
key and the Responses protocol ticked (the Azure OpenAI preset ticks it) runs agents on
the Responses API (`api: "openai-responses"`); every other connection runs them on Chat
Completions (`api: "openai-completions"`), which also stays the fallback when the
connection test unticks Responses. Azure reasoning deployments need Responses: on Chat
Completions they refuse function tools together with `reasoning_effort` ("Function
tools with reasoning_effort are not supported for … in /v1/chat/completions"), and
`/think off` does not help. Keyless connections stay on Chat Completions because the
pinned runtime's local authentication covers only keyless Chat Completions providers.
Hermes agents follow the same rule ([Hermes runtime](hermes-runtime.md#model-connection)).

From the connection, agents on Chat Completions use the per-model image support, the
max-tokens field, the stream-usage option, and a reasoning-effort option the connection
test found refused (`reasoning_effort` is then never sent). Agents on Responses use the
per-model image support, the prompt cache key option, and a refused reasoning option
(the model is then written without reasoning); Responses always sends
`max_output_tokens`, so the max-tokens field does not apply. Route choices and all
other protocol adapter options (parallel tool calls, reasoning replay, system messages,
think-tag extraction) apply only to coding CLIs that use an adapter route, and the
adapter option panel is shown only while such a route exists. Hermes agents keep Chat
Completions for every endpoint connection.

## Prices

An agent's [usage](agents.md#usage) shows a cost only where the model has a price.
OpenClaw prices a model on a custom provider only from the model entry's own `cost`
(USD per 1M tokens for `input`, `output`, `cacheRead` and `cacheWrite`); its hosted
catalog covers its own providers, not the ones AgentPier compiles per connection.

- **OpenRouter.** AgentPier compiles `cost` from its provider catalog (OpenRouter's
  `pricing.prompt`, `completion`, `input_cache_read` and `input_cache_write`). A
  model without a cache price of its own is priced at its input price for cached
  input. A model the catalog does not list, or one with dynamic pricing, gets no
  `cost`. When an answer names what OpenRouter billed (`usage.cost`), OpenClaw
  records that amount and uses the compiled price only for answers without one. A price that
  changes in the catalog reaches an agent with its next model apply or Gateway
  start.
- **Endpoints.** A connection's models carry no price in AgentPier, so their entries
  have no `cost` and their usage shows tokens only, unless the service reports an
  amount with its answers.
- **ChatGPT accounts** are subscriptions: never a cost.

Details: [Usage](assistant-gateway.md#usage).

## Verification

`node --test tests/unit/assistant-provider-endpoint.test.js` exercises selection,
limits, authentication mapping, isolation, unavailable cases, rotation and leases.
The optional native test starts an owned Gateway with freshly generated disposable
state and a local deterministic SSE server. Point this variable at an immutable
pinned runtime installation containing `node/bin/node` and
`app/node_modules/openclaw/openclaw.mjs`:

```sh
AGENTPIER_ASSISTANT_PROVIDER_RUNTIME=/absolute/path/to/pinned-runtime \
  node --test tests/integration/assistant-provider-contract.test.js
```

It validates real streamed function calls, tool-result continuation, endpoint paths,
Bearer/custom/no-auth headers, and absence of fixture secrets in model request
bodies, history, capability responses, runtime logs and redacted Gateway configuration.
`assistant-provider-responses-contract.test.js` runs the same tool loop against a
local server that answers like an Azure reasoning deployment: it refuses function
tools with `reasoning_effort` on Chat Completions and accepts them on Responses. The
agent's turn goes to `/openai/v1/responses` with the key in `api-key` only.
The sibling `assistant-provider-schedule-contract.test.js` verifies actual native
cron execution after rotation/restart and proves a forced revoked job cannot reach
the model server. Synchronization and HTTP-route tests cover maintenance conflicts,
disabled state, validation failures, and fail-closed configuration/cron errors. It does
not contact a real Ollama, llama.cpp, Azure, or paid model account.

## Native ChatGPT account logout

Logging out a native ChatGPT account enters the same maintenance boundary as central
credential changes: active or uncertain work blocks the operation, and dependent
schedules pause before removal. Native account removal must not strip the effective
account selection and permit another account to take over. Pre-spawn preparation
therefore restores the exact selected profile with no fallback, retaining only its
private non-secret identity after logout. Missing accounts stay unavailable after
restart; enabling a different account requires an explicit agent model change.
A lost logout acknowledgement leaves the service in maintenance for recovery rather
than resuming uncertain state. Existing conversations and native memory are retained.
Logging out a login AgentPier holds removes it from AgentPier's vault and its
access-only profile from OpenClaw's store, also while the agent service is stopped,
and removes the profile from every update snapshot (backup keys stay); neither
revokes anything at OpenAI.

## ChatGPT logins held by AgentPier

A ChatGPT account is one login per account, host-wide, never one per agent.
AgentPier holds it: **Connections › Model access › ChatGPT for agents** runs
OpenAI's device-code sign-in from AgentPier itself (public Codex client,
`/api/accounts/deviceauth/usercode`, polling, `/oauth/token`), shows the code and
`https://auth.openai.com/codex/device`, and works while the agent service is
stopped. The tokens go into AgentPier's vault, `<data>/model-logins/chatgpt.json`
(owner-only, `0600` in a `0700` folder, outside the agent runtime's update
snapshots), and never into a response, a log or a runtime's configuration.

AgentPier is the only refresher (OpenAI rotates the refresh token; a second
refresher signs both out with `refresh_token_reused`): one renewal at a time per
login, saved before anything uses it, 30 minutes before expiry or at half the
lifetime when that comes first, again when a token is used within ten minutes of its
expiry, and once when an upstream answers 401. `refresh_token_reused`,
`invalid_grant` and their siblings mark the login **Sign-in required**.

The runtimes get access only:

- **OpenClaw** gets an access-only OAuth profile (`type: "oauth"`,
  `provider: "openai"`, `access`, `expires`, `accountId`, `email`, `displayName`,
  `chatgptPlanType`; an empty `refresh`, no `authFlow`) under the same profile id, so
  `openai/<model>@<profile>` selections stay as they are. `refresh` is the empty
  string, never missing: OpenClaw 2026.11.3 counts an OAuth profile without a string
  `refresh` as retired, so no routine could record it as its inference account
  (see [routine accounts](assistant-runtime-updates.md#routine-inference-accounts-openclaw-2026113)). AgentPier writes it into
  OpenClaw's own auth profile store (the state database's machine state, or the
  main agent's database on older layouts) in one `BEGIN IMMEDIATE` transaction that
  changes only that profile, refuses unknown layouts and shapes, and then calls
  `models.authRefresh { operation: "update", agentId: "main" }` once the Gateway
  admitted its agents (a refresh while OpenClaw still publishes an agent leaves that
  agent degraded, see [degraded agents](assistant-gateway.md#degraded-agents-agentpier-238)).
  It writes again on every renewal and before every Gateway start; once that
  Gateway is ready it reloads only the profiles renewed while it started. With a usable token OpenClaw never
  refreshes, and with an empty refresh token its refresh claim gives up quietly, so all
  of OpenClaw's ChatGPT features (chat, `image_generate`, transcription, realtime,
  usage, embeddings) stay on the profile. Without a usable refresh token OpenClaw reports
  the profile as `expiring` within 24 hours of its expiry; AgentPier counts that as
  signed in.
  Models only the account's discovery lists (`/codex/models`, such as GPT-6.2-Astra)
  have their ChatGPT route only from that discovery, which OpenClaw 2026.11.6 keeps
  per agent and does not run for a turn; its Doctor migration drops what 2026.11.3
  kept. AgentPier therefore asks for each agent's discovery (`models.list` with
  `refresh` for that agent, `account-model-discovery.js`) once a Gateway is ready, for
  every agent pinned to an `openai/<model>@<profile>`, and after it creates an agent
  on, or moves one to, such a model. Without it every turn of such an agent failed
  after the update ("No route-compatible authentication source is configured for
  openai", AGENTPIER-487).
- **Hermes** reaches the account through AgentPier's model proxy, for chat and for
  **Create images**, see [Hermes runtime](hermes-runtime.md#model-connection) and
  [images](hermes-runtime.md#images). Hermes never depends on a running
  OpenClaw: while the Gateway is not running, AgentPier reads a held login's model
  list itself from the Codex backend (`/codex/models` with the login's token), so the
  model picker works on a Hermes-only setup.

A sign-in waiting for the owner does not hold back an agent runtime update. During
maintenance (an update, its snapshot or a rollback) renewals and new sign-ins reach
OpenClaw's store at the next Gateway spawn instead.

The model proxy is a listener of its own on `127.0.0.1` (port and key in
`<data>/model-logins/proxy.json`, stable across restarts), never AgentPier's web
port, so remote access cannot reach it; browser requests are refused. A runtime
holds only an HMAC credential for one scope (`chatgpt` + agent + profile, or one MCP
server + agent), which rotating the key revokes. Every request is checked against
the current store (`proxy-access.js`): a ChatGPT credential works only while that
Hermes agent exists, is not archived, belongs to an active user (if any) and its
current model is that login, so a changed model, an archived or deleted agent or a
disabled user revokes it at once; the images endpoints
(`/chatgpt/codex/images/generations`, `/images/edits`) also while the agent may create
images now and AgentPier picked that login for its images. `/chatgpt/codex/responses`,
its compact variant and `/chatgpt/codex/models` go to `https://chatgpt.com/backend-api/codex`
with the account's token, `ChatGPT-Account-Id` and the residency header; SSE streams
pass unbuffered. A 401 renews the login once and replays the request. A login that
needs a new sign-in answers `401 agentpier_login_required`, a failed renewal `503`
with `Retry-After`; other answers (429 with its headers, 5xx) pass through without
`WWW-Authenticate` or cookies.

### Logins OpenClaw made before

A ChatGPT login OpenClaw made before this change stays exactly as it was, refreshed
by OpenClaw, until the owner moves it: the account's detail shows **Move this
ChatGPT login to AgentPier**. Nothing moves on its own. The move is refused while a
run uses the account, works with the agent service running or stopped, and:

1. rewrites every update snapshot taken before so it no longer holds the profile's
   refresh token: the sealed credential rows are unsealed, the token removed and the
   rows sealed again with the snapshot's own key, so rollbacks stay possible and none
   brings back a second refresher. A part that cannot be rewritten safely is kept
   but marked (`withheldSealed`); a restore leaves its credentials out. Before every
   Gateway spawn AgentPier writes its access-only profiles again, also over whatever
   a restore brought back;
2. reads the refresh token once and leaves OpenClaw's profile access-only in the
   same transaction (a profile in the middle of an OpenClaw refresh is refused);
3. stores the tokens in AgentPier's vault under the same profile id.

Until it is moved, Hermes agents cannot choose that account (`runtimeAccount`,
`modelAccountRuntime`).

### Verification

`tests/unit/chatgpt-vault.test.js`, `assistant-model-account-login.test.js`,
`assistant-model-accounts.test.js`, `assistant-model-account-move.test.js`,
`openclaw-access-profiles.test.js` and `runtime-proxy.test.js` use a fake OpenAI
issuer and Codex backend. The native contract
`tests/integration/assistant-chatgpt-access-contract.test.js` runs the pinned
OpenClaw (`AGENTPIER_ASSISTANT_PROVIDER_RUNTIME`) with synthetic tokens behind a
proxy stub that blocks every outgoing connection: the access-only profile is
accepted, a profile within OpenClaw's five-minute margin is never refreshed (no
request to `auth.openai.com`, no fence), a renewed token is adopted without a
restart, and a profile OpenClaw's own writer stored moves to AgentPier.
`tests/integration/assistant-chatgpt-access-cross-version.test.js` (with
`AGENTPIER_ASSISTANT_PREVIOUS_RUNTIME` and `AGENTPIER_ASSISTANT_UPDATE_RUNTIME`) signs
in on the previous runtime, lets OpenClaw discover GPT-6.2-Astra from a fake Codex
backend behind an intercepting proxy (`tests/helpers/chatgpt-interceptor.js`), runs a
turn, activates the candidate through the update path and runs turns of the existing
and of a new agent on it.

Still to verify with the owner on a real account (a separate AgentPier instance with
its own data): the five OpenClaw features above on an access-only profile, and
whether a 401 or a usage-probe cooldown OpenClaw records for a profile clears when
AgentPier writes a new token.
