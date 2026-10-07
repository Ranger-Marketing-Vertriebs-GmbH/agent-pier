# Codex context windows and model status

AgentPier displays the effective context window reported by the running Codex
session (`token_count.info.model_context_window`). This can be smaller than the
maximum published for the API model. The UI must not replace the session's native
limit with a model marketing limit.

Codex distinguishes three catalog values:

- `context_window`: the default window.
- `max_context_window`: the maximum allowed configuration override.
- `effective_context_window_percent`: the usable percentage after native headroom.

In the Codex 0.160.1 catalog inspected on 2026-10-07, GPT-6 Astra had a default of
272,000 tokens, a maximum of 872,000 and a usable percentage of 95. Consequently,
the default native limit is 258,400. An explicit `model_context_window = 1000000`
was clamped to 872,000 and reported as 828,400 usable tokens. These are
version/account catalog observations, not permanent model constants. The public
[Astra API model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
listed 1,050,000 tokens; that API maximum does not establish a Codex session's
configured budget.

The [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents `model_context_window` and `model_auto_compact_token_limit`. The CLI
applies its catalog maximum and headroom to configuration overrides. AgentPier
preserves those overrides through its app-server bridge and reload; it does not
silently enlarge the window, change compaction settings or rewrite the native
catalog. Why an upstream account catalog supplies a particular maximum cannot be
determined from these fields alone.

The native percentage is also baseline-normalized, rather than simply
`100 * (1 - used / limit)`. With 53,247 used tokens and a limit of 258,400, Codex's
12,000-token baseline produces 83% remaining. AgentPier uses that same calculation.

For model status, current Codex versions render the model and effort in the live
composer footer. Older versions also render a boxed startup header. AgentPier
recognizes those structures and retains the last valid observation when native
status is unavailable. Model-like prose, tool schemas such as `model: string,`,
and quoted change receipts do not establish the selected model.

Reload resolves native display labels through the account-scoped `model/list`
catalog and managed provider metadata. It preserves exact model ID spelling and
explicit reasoning levels, including `max` and `ultra`. An ambiguous or unknown
label stops reload before the running process is replaced; an independently
observed exact ID can still be used when it is absent from the catalog.

## Isolated compatibility check

Run the installed CLI against the disposable loopback provider:

```sh
AGENTPIER_TEST_CODEX_BIN="$(command -v codex)" \
  node --test tests/integration/codex-remote-reload-native.test.js
```

The fixture owns its homes, model catalog and private tmux socket. It checks the
default window and a larger override before and after reload without using real
accounts or contacting a model API.
