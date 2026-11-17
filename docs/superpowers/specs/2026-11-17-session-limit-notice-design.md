# Session limit notice — short design

## Intent

When a native CLI session (Claude Code, Codex) hits a usage or rate limit, AgentPier
today only sends a push. The chat shows the CLI's limit text as an ordinary assistant
reply, the session list shows the session as idle, and nothing offers a way on. On
2026-11-17 two Claude sessions hit the per-model "Fable limit" (reset three days later);
one sat idle for five hours until the owner switched to Opus by hand with `/model`.

Goal: the owner sees at a glance that a session is blocked by a limit, until when, and
can continue with another model from the chat.

## Goals

- Persist a session's limit state (CLI message, optional reset text) when the CLI reports
  `StopFailure` with `rate_limit`/`billing_error` (Claude) or a usage-limit
  `turn/completed` (Codex). Clear it when the next turn starts or ends normally.
- Chat: show a limit notice instead of a plain reply bubble, with **Change model**
  (opens the existing model picker, `ModelControl`) and **Continue** (sends a fixed
  continue prompt, translated).
- Session list / session header: a "Limit" status instead of "ready".
- State reaches the browser through the existing native-activity live path.

## Non-goals

- No automatic model switch, no guessing which model is still free (approach B).
- No session restart/reload with a new model (approach C).
- No parsing of the reset time into a timestamp beyond showing the CLI's own text.

## Approaches

- **A — notice with "Change model" + "Continue" (picked).** Reuses the native model
  picker bridge; AgentPier never guesses a free model. Two clicks.
- B — one click "Continue with Opus": AgentPier picks a fallback from the picker and
  maps the limited model name from the CLI text. Rejected: fragile against CLI text
  changes; AgentPier does not know which models are still free.
- C — reload the session with another model. Rejected: heavier than an in-session
  `/model`, which already works.

## Shape

- Server: `claudeHookActivity`/Codex activity records `limit: { detail }` on the
  activity file at a limit failure; any later activity write drops it. The session
  listing and chat snapshot expose it.
- Claude transcript: the synthetic `isApiErrorMessage` record with `error: rate_limit`
  is shown as the limit notice (Codex already has `codex-turn-error:*`).
- Web: a notice component built from existing UI-guide primitives; buttons disabled while
  the session is busy. German and English copy, translation lock updated.
- Docs: `docs/architecture.md` (native activity / live), user-facing chat docs.

## Left to the builder

Exact component placement, the continue prompt wording, test layout.
