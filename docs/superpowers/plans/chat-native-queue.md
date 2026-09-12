# Native chat delivery observation

## Objective

Distinguish terminal transport from native queue acceptance and native consumption for Codex, Claude Code and OpenCode. Preserve existing write-ahead custody and explicit recovery; observations must never trigger input or weaken retry guards.

## Evidence spike

Use disposable profiles, a private tmux server and a loopback mock provider. Hold a native response, send another message through HTTP, record the current queue chrome and provider input, then observe consumption. Verify multiple messages, duplicate content, narrow layouts and messages still in the composer. Queue text elsewhere in the transcript must not establish acceptance. Record provider/version-specific limitations.

## Design gates

- Transport receipt remains independent from observation; successful Enter is not native acceptance.
- Queue evidence must identify the exact outgoing attempt within its session/account/launch and native queue region. Unknown or ambiguous evidence stays unconfirmed.
- Queue disappearance alone never confirms consumption. Native conversation/protocol evidence must support the next state.
- Prefer structured native events, then bounded native-chrome observations if proven by the spike. Reuse the streamed chat connection for updates; do not add browser polling.
- UI: sending; handed to terminal, awaiting confirmation; observed in CLI queue; native message observed/consumed only when supported; uncertain/failed with existing safe recovery.
- Queue status remains visible next to the message, even if a provider creates its history row before processing. Do not promise the same processing boundary for every CLI.
- Preserve scope isolation, clear/reload/account switching, repeated identical input, cross-tab persistence and reconnect behavior.

## Implementation and validation

1. Characterize real native formats and select supported evidence per provider.
2. Implement bounded observation adapters and lifecycle/stream integration, keeping transport receipts backward compatible.
3. Add localized German/English message status presentation with compact mobile layout and no false retry affordance for queued messages.
4. Regression tests for state transitions, ambiguous/duplicate input, recovery and scope changes; browser checks in both languages and engines; real native held-response probe.
5. Run repository checks, retain lasting evidence in docs, remove this completed plan before opening a PR. No release is requested for this change yet.
