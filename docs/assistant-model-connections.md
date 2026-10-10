# Model connections for managed assistants

Assistants use the existing central model connections. Configure a connection in
AgentPier's model provider settings, then select it in the assistant settings and
enter the exact configured model ID. Each assistant and team member can select its
own connection and model. Native ChatGPT account selection and OpenRouter remain
available through their existing paths.

| Connection                 | Central settings                                                                          | Assistant transport        |
| -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| Ollama                     | Ollama preset; normally `http://127.0.0.1:11434/v1`                                       | Chat Completions streaming |
| llama.cpp                  | llama.cpp preset; normally `http://127.0.0.1:8080/v1`                                     | Chat Completions streaming |
| Generic compatible service | Custom preset; service's API base URL                                                     | Chat Completions streaming |
| Azure OpenAI / Foundry v1  | Custom preset; `https://RESOURCE.openai.azure.com/openai/v1`; deployment name as model ID | Chat Completions streaming |

Enable the connection's Chat Completions protocol and configure each model's context
window (at least 4,000 tokens, the pinned runtime's hard minimum). The configured
output limit is preserved; an omitted limit uses the central
connection's normal default (a quarter of context, capped at 32,000 tokens). Use a
model that supports streamed function calls for assistant tools. Configuring a
connection does not prove that the selected model can reason or use tools correctly.

With an API key and no custom authentication header, the key is sent as Bearer
authentication. The custom `api-key` header sends the raw key there and an empty
Authorization
header to suppress the SDK's default Bearer credential. A custom `Authorization`
header sends the raw configured value, which may include a prefix when required. For Azure,
set `api-key` as the custom authentication header and save the Azure API key.
The v1 URL does not require a dated `api-version` query parameter. Azure's model ID
is the deployment name, which can differ from the underlying model name.
See [Microsoft's v1 API documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle).

Keyless local connections use OpenClaw's native local authentication handling;
AgentPier does not create a fake key. Supported local hosts are localhost, loopback
addresses, RFC1918 IPv4 addresses, `.local` names, and the native runtime's Docker/Orb
host aliases. Public keyless endpoints are unavailable because the pinned runtime
requires credentials for them. URLs requiring query parameters, legacy Azure
`/deployments/...` APIs, automatic Entra token acquisition, and Responses-only or
Messages-only connections are outside this adapter's supported contract. Unsupported
catalog providers remain unavailable rather than silently selecting another account.
Arbitrary custom authentication headers (for example `X-Inference-Key`) are unavailable
when a key is configured: pinned OpenClaw 2026.9.8 and its OpenAI SDK cannot suppress
the implicit Bearer credential safely for those headers through supported configuration.
AgentPier reports `unsupportedAuthentication` instead of sending the key twice.

The connection lease blocks editing or removal while its configuration is being
resolved and applied. Subsequent resolution reads the current central credential.
Editing or removing a connection referenced by an assistant restarts its Gateway, so
the request needs `confirmRestart: true`; without it the route answers 409
`ASSISTANT_RESTART_REQUIRED` and the Accounts page asks for that confirmation. The
change then uses the shared runtime maintenance gate. Active or uncertain work prevents the change. The owned Gateway
stops before central credentials change; its managed provider/profile configuration
is refreshed before restart. A runtime that was disabled remains disabled.
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

Agents call an endpoint connection's Chat Completions API directly through OpenClaw.
From the connection they use the per-model image support, the max-tokens field and the
stream-usage option. Route choices and all other protocol adapter options (reasoning
effort, parallel tool calls, prompt cache key, reasoning replay, system messages,
think-tag extraction) apply only to coding CLIs that use an adapter route, and the
adapter option panel is shown only while such a route exists.

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
