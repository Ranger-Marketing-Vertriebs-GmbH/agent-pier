# Auto-resume interrupted sessions

Status: draft for review · 2026-10-10

## Goal

When the tmux server that hosts AgentPier sessions disappears, every session that was running
comes back on its own with its native conversation. This covers a host reboot (`/tmp` and all
CLI processes are gone) and a tmux server that is killed while AgentPier keeps running.

Success: after a reboot and login, or after a tmux server loss, each previously running
eligible session is running again with `--resume`/`resume`/`--session` of its own conversation,
without user action. A session that cannot be resumed shows why and can be retried manually.

## Non-goals

- Restoring in-flight work: an unfinished model reply, running tool processes, terminal
  scrollback of the lost server. The conversation resumes from its last persisted state.
- Resuming a session whose CLI exited on its own (`/exit`, crash of one CLI, non-zero exit).
- Pipeline steps (`session.pipeline`), purpose sessions, history-only imports and tools other
  than Claude Code, Codex and OpenCode. Pipelines keep their own recovery.
- Starting AgentPier before login. The LaunchAgent and the systemd user unit stay unchanged.

## Detection: a lost tmux server

`SessionManager.current()` already maps tmux errors to `status: "stopped"`. tmux runs with
`remain-on-exit on` and `exit-empty off`, so a CLI that exits leaves a dead pane on a live
server. A session therefore counts as **interrupted** only when its tmux server is gone:

1. **Server unreachable:** `no server running`, `failed to connect`, `error connecting` or
   `no such file` (socket missing after reboot).
2. **Server replaced:** `can't find …` while a tmux server answers whose identity (pid and
   `#{start_time}`, because pids are reused after a reboot) differs from the one recorded for
   the session. This covers a new server that another launch created
   before the old sessions were observed.

To support (2), the session records `{ pid, startTime }` of its server in `session.tmuxServer`
when it is created or replaced. Sessions without a recorded identity fall back to rule (1) only.

On a running → stopped transition that matches (1) or (2), the session gets:

```json
"interruption": { "cause": "tmux-server-lost", "at": "<ISO time>", "resume": "pending" }
```

A user stop kills only the tmux session on a live server with the same identity, so it never
matches.
Stop, delete and a successful manual reload clear `interruption`.

## Resume: `SessionAutoResume`

New service `server/features/sessions/session-auto-resume.js`, created in `services.js` next to
`SessionReload`.

- **Triggers:** once after `SessionReload.initialize()` at server start, and whenever
  `current()` records a new interruption (callback `onInterrupted`).
- **Queue:** one session at a time, oldest interruption first. For each session it calls
  `reload.request(id, { requestId: randomUUID(), mode: "now" })` and waits until the session is
  `running` with `reload.state: "completed"` or the reload has failed, with a 2-minute timeout per
  session.
- **One attempt per interruption:** before the call `interruption.resume` becomes `"started"`, so
  a server restart during the attempt does not repeat it. A successful replacement removes the
  marker; otherwise it becomes `"failed"` with a stable reason code. A new interruption after a successful resume starts a new
  attempt; a session whose resume failed is not retried automatically.
- **Eligibility:** exactly the existing reload rules (`SessionReload.inspect`: supported tool, no
  purpose/pipeline/history-only, verified native conversation). Ineligible sessions get
  `resume: "skipped"` with the reason and stay stopped.
- **Errors before the reload is recorded** (for example a missing CLI binary or changed provider)
  are stored as `resume: "failed"` with reason `prepare-failed`, because `SessionReload` records no
  state for preparation failures.
- The existing `SessionReload` and `replaceSession` code paths stay unchanged apart from clearing
  `interruption` on a successful replacement.

## Setting

`preferences.json` gains `autoResumeInterrupted` (boolean, default `true`). `Preferences.get()`
returns it and `update()` accepts it. When it is `false`, interruptions are still recorded but
nothing is resumed automatically. The directory settings page gets a toggle:

- de: „Unterbrochene Sitzungen automatisch fortsetzen" with a hint that sessions continue after a
  restart or tmux loss and that sessions stopped by the user stay stopped.
- en: "Resume interrupted sessions automatically" with the matching hint.

## Visibility

- The session view shows a short notice for stopped interrupted sessions: being resumed, or
  resume failed/skipped with the translated reason. A failed or skipped session keeps
  the existing manual "Neu laden & fortsetzen" action.
- An audit event `session.restored` (outcome success/failure, source `system`) is written per
  attempt next to the existing `session.ended`.

## Testing

- Unit (`SessionManager` with a fake tmux runner): unreachable server → interruption; `can't find`
  with a different server identity → interruption; `can't find` with the same identity (user stop) and a
  dead pane (CLI exit) → no interruption.
- Unit (`SessionAutoResume` with fake reload): order, one-at-a-time, one attempt per interruption,
  restart during an attempt, ineligible sessions, preparation failures, setting off.
- Unit: preferences validation and default; catalog parity for the new strings.
- Integration with an isolated tmux socket and a fake CLI: start two sessions, `kill-server`,
  observe both relaunched with the resume argument; stop one session manually beforehand and
  verify it stays stopped.
- Browser (Playwright, English UI): the settings toggle and the failed-resume state.
