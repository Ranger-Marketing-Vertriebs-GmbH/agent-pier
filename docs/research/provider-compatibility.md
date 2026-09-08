# Provider compatibility for AgentPier

Research date: 2026-09-06. This is an implementation contract, not an end-to-end connectivity certification. No credentials were inspected, software installed, or inference requests sent. Local read-only checks found Codex CLI `0.153.4` and Claude Code `2.1.263`; OpenCode was absent from the research shell's PATH. Other AgentPier executable directories may still contain it.

## Existing application boundary

At research time, `server/accounts.js` represents accounts as `{tool, kind, hasSecret}` and injects `ANTHROPIC_API_KEY` for Claude or `OPENAI_API_KEY` for both other CLIs. Codex managed profiles write OpenAI auth files. This cannot represent OpenRouter or Z.ai correctly. Managed profiles already isolate Codex and Claude configuration directories and OpenCode XDG directories. Preserve that isolation and existing local accounts.

`server/models.js` controls the existing CLI model picker; it does not own a provider catalog. Its current-model labels are CLI observations, not proof of provider model identity or context capacity. Session creation in `server/sessions.js` receives a command, arguments and environment. Provider configuration belongs before this boundary.

## Compatibility matrix

“Provider-documented” means the provider supplies integration instructions; it does not imply the CLI vendor supports every routed model.

| CLI         | Provider         | Native route                                         | Status and condition                                                                                |
| ----------- | ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex       | OpenRouter       | Responses; `https://openrouter.ai/api/v1`            | Provider-documented; exact model and tool compatibility still matter.                               |
| Codex       | Z.ai             | Responses; `https://api.z.ai/api/v1`                 | Provider-documented for GLM-5.3; account protocol entitlement must permit Responses.                |
| Codex       | Z.ai Coding Plan | Responses; `https://api.z.ai/api/v1`                 | Provider guide explicitly covers Individual/Team Plan keys; require explicit Responses entitlement. |
| Claude Code | OpenRouter       | Anthropic Messages; `https://openrouter.ai/api`      | Provider-documented. Claude models and non-Claude models have different vendor support status.      |
| Claude Code | Z.ai             | Anthropic Messages; `https://api.z.ai/api/anthropic` | Z.ai-documented GLM integration; not supported by Anthropic as a non-Claude model.                  |
| OpenCode    | OpenRouter       | Built-in `openrouter` provider                       | Preferred native integration; preserve its adapter and catalog.                                     |
| OpenCode    | Z.ai API         | Built-in `zai` provider                              | Native integration; API-account billing/entitlement.                                                |
| OpenCode    | Z.ai Coding Plan | Built-in `zai-coding-plan` provider                  | Native integration; select separately from the API product.                                         |

Sources: [OpenRouter Codex](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli), [Z.ai Codex](https://docs.z.ai/devpack/tool/codex), [OpenRouter Claude Code](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration), [Z.ai Claude Code](https://docs.z.ai/devpack/tool/claude), [OpenCode providers](https://opencode.ai/docs/providers/).

Unsupported combinations include a Chat-Completions-only endpoint configured as a Codex Responses provider, and an OpenAI-protocol endpoint supplied as Claude's Anthropic base URL. Current Codex supports only `wire_api = "responses"`. Anthropic explicitly excludes routing Claude Code to non-Claude models from its support, even when a gateway is protocol-compatible. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Anthropic gateway support boundary](https://code.claude.com/docs/en/llm-gateway).

Z.ai's GLM-5.3 page currently states that users who previously subscribed to Coding Plan, including expired subscribers, have model API access only through Chat Completions. Its Codex guide separately describes Responses access for Individual and Team Coding Plan keys. Treat this as an account-specific entitlement distinction, not a blanket Coding Plan prohibition. Do not infer entitlement from the key format or claim universal Responses availability; show this limitation and let the account explicitly identify its service. Do not silently move a subscription account to paid API routing. [Z.ai GLM-5.3 protocols and account restriction](https://docs.z.ai/guides/llm/glm-5.3), [Coding Plan Codex guide](https://docs.z.ai/devpack/tool/codex).

## Exact launch configuration

These are private per-account configuration examples. `<selected-model-id>` is an exact catalog ID, never a display name. Inject keys into the child environment from private storage; do not embed actual secrets in arguments, public account JSON or examples.

### Codex

OpenRouter's current guide recommends command-backed authentication because it triggers model-catalog refresh; the guide says `env_key` authenticates but does not provide that catalog refresh. Use the native catalog instead of synthesizing metadata from a model name. [OpenRouter Codex integration](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli).

```toml
model_provider = "openrouter"
model = "<selected-model-id>"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"

[model_providers.openrouter.auth]
command = "sh"
args = ["-c", "printf '%s' \"$OPENROUTER_API_KEY\""]
```

The child receives `OPENROUTER_API_KEY`. A platform adapter must use a Windows-compatible token command on Windows. The command string is fixed application code; it must never interpolate the key or user-controlled text.

Z.ai publishes a Codex model metadata file including `glm-5.3`, `context_window = 1048576`, `max_context_window = 1048576`, and `effective_context_window_percent = 95`. Generate its version-compatible catalog privately, with an absolute path. The provider example uses an inline token; this proposed adaptation uses the documented Codex environment-key facility instead. [Z.ai Codex metadata](https://docs.z.ai/devpack/tool/codex), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

```toml
model_provider = "zai"
model = "glm-5.3"
model_catalog_json = "/absolute/private/profile/codex/models.json"

[model_providers.zai]
name = "Z.ai"
base_url = "https://api.z.ai/api/v1"
env_key = "ZAI_API_KEY"
wire_api = "responses"
```

Here `ZAI_API_KEY` is an AgentPier-chosen variable wired by `env_key`, not an asserted built-in CLI variable. Avoid an unconditional reasoning-effort value: Z.ai's example uses `max`, while the OpenAI configuration reference enumerates a different set. Validate installed CLI/catalog capabilities. Local `codex debug models --help` confirms `--bundled` skips refresh; do not inspect live catalogs using a user's credentials during tests.

### Claude Code

For OpenRouter, inject:

```text
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=<private OpenRouter key>
ANTHROPIC_API_KEY=
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
ANTHROPIC_MODEL=<selected OpenRouter model ID>
```

The explicitly empty API-key variable prevents competing API-key authentication. An isolated API profile must not reuse a cached personal login. OpenRouter documents gateway discovery and role model overrides. [OpenRouter Claude setup](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

For Z.ai, inject the same auth-token shape with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`. Its current example maps `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL` to `glm-5.3[1m]`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` to `glm-5.3-flash[1m]`, with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`. Set the session model explicitly too. The `[1m]` marker is a Claude selection modifier, not the upstream GLM ID. [Z.ai Claude recipe](https://docs.z.ai/devpack/tool/claude).

Role mapping must use real provider IDs; record both alias and target. Do not label a GLM mapping simply “Opus” as though it were an Anthropic model. Gateway discovery reads `/v1/models`, is opt-in, and remains subject to allowlists. [Claude gateway connection and discovery](https://code.claude.com/docs/en/llm-gateway-connect).

### OpenCode

Use the native `openrouter` provider with the child variable `OPENROUTER_API_KEY`. A private `opencode.json` can explicitly bind the same key without duplicating the adapter:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/anthropic/claude-sonnet-4.6",
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" }
    }
  }
}
```

OpenCode model IDs are `provider_id/model_id`, so the extra `openrouter/` is required by OpenCode but must not be sent as part of the upstream OpenRouter slug. Config supports environment substitution. [OpenCode model selection](https://opencode.ai/docs/models/), [OpenCode config variables](https://opencode.ai/docs/config/).

The public Models.dev catalog, used by OpenCode, currently declares:

| Provider ID       | Native credential variable | Native endpoint                       | Adapter                       |
| ----------------- | -------------------------- | ------------------------------------- | ----------------------------- |
| `openrouter`      | `OPENROUTER_API_KEY`       | `https://openrouter.ai/api/v1`        | `@openrouter/ai-sdk-provider` |
| `zai`             | `ZHIPU_API_KEY`            | `https://api.z.ai/api/paas/v4`        | `@ai-sdk/openai-compatible`   |
| `zai-coding-plan` | `ZHIPU_API_KEY`            | `https://api.z.ai/api/coding/paas/v4` | `@ai-sdk/openai-compatible`   |

Choose `zai/glm-5.3` or `zai-coding-plan/glm-5.3` accordingly. Bind `provider.<id>.options.apiKey` to `{env:ZHIPU_API_KEY}` if writing explicit config. Do not replace native OpenRouter with a generic OpenAI-compatible provider. [Models.dev public catalog](https://models.dev/api.json), [native Z.ai selection](https://docs.z.ai/devpack/tool/opencode).

## Context resolution: preserve three different quantities

AgentPier should separately represent provider-advertised context, CLI-assumed context, and compaction threshold. None enlarges the provider's actual capacity. Token counts must be integers, with source and retrieval time; preserve unknown values as `null`.

Claude's `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is conditional. For an unrecognized, non-`claude-` ID without `[1m]`, it changes the assumed window while retaining compaction. An unrecognized `[1m]` ID also requires `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to correct that assumption. An ID starting with `claude-` or resolving to Claude applies the override only with `DISABLE_COMPACT`, which disables compaction. Therefore AgentPier must not offer arbitrary context changes for recognized Claude models or automatically disable compaction. Use supported model variants and expose the native assumption. [Claude context correction](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

The current semantics are documented as of Claude `2.1.193`. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` controls output, not context; raising it reduces room before compaction. Gateway discovery does not prove the CLI adopted a model's context metadata. [Claude environment-variable reference](https://code.claude.com/docs/en/env-vars).

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is a threshold, capped at the CLI model window; it cannot force a larger window. Keep the provider's capacity visible even when the CLI budgets less. [Claude compaction configuration](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction).

OpenCode reads standard-provider limits from Models.dev; additional models may specify `provider.<id>.models.<model-id>.limit.context` and `.limit.output`. Prefer native metadata, then explicit verified overrides. [OpenCode model limits](https://opencode.ai/docs/providers/#custom-provider).

## Catalog evidence and implementation strategy

Read-only public requests to [OpenRouter models](https://openrouter.ai/api/v1/models) and [Models.dev](https://models.dev/api.json) on the research date returned the following. These observations are snapshots, not permanent defaults:

| Catalog / model                          | Advertised context | Top-provider context | Output limit |
| ---------------------------------------- | -----------------: | -------------------: | -----------: |
| OpenRouter `z-ai/glm-5.3`                |          1,310,720 |            1,048,576 |      262,144 |
| OpenRouter `z-ai/glm-5.3-flash`          |          1,310,720 |            1,048,576 |      131,072 |
| OpenRouter `anthropic/claude-sonnet-4.6` |          1,000,000 |            1,000,000 |      128,000 |
| Models.dev `zai/glm-5.3`                 |          1,000,000 |         Not supplied |      131,072 |
| Models.dev `zai-coding-plan/glm-5.3`     |          1,000,000 |         Not supplied |      131,072 |

OpenRouter exposes `id`, `context_length`, `top_provider.context_length`, `top_provider.max_completion_tokens`, modalities and supported parameters. Its top-provider context can differ from the model headline; keep both and do not promise the headline as a guaranteed routed limit. [OpenRouter model schema](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Proposed application contract:

1. Account metadata adds explicit provider and service identifiers; secrets remain private. Native CLI defaults stay a separate choice for existing accounts.
2. Catalog entries carry `{providerId, modelId, cliModelId, label, contextTokens, outputTokens, source, fetchedAt, capabilities}`. Store routing-specific limits separately where supplied.
3. CLI adapters resolve launch configuration and report `{requestedModelId, effectiveModelId, contextSource, contextApplied, notice}`. A requested model is not “effective” until the CLI confirms it.
4. Public catalog refresh uses an allowlisted endpoint, bounded response size/timeout, validated fields and a dated cache. Failures preserve the last good catalog with stale status. Never make an inference call to populate a picker.
5. Session model changes must invalidate metadata derived from the previous model. Process-wide Claude context overrides cannot safely follow arbitrary mid-session model changes; require a new launch when necessary.
6. Regression tests should cover provider-specific auth variables, endpoint selection, native OpenCode IDs, alias-to-target labels, missing/contradictory limits, CLI-version gating, legacy account migration, and absence of secrets from API payloads/logs. Provider connectivity remains a separately authorized smoke test.

These are design recommendations derived from the preceding evidence; they do not claim the current application already implements them.
