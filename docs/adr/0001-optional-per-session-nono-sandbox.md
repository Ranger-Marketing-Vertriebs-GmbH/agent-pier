# Optional per-session nono sandbox

---

Status: accepted

---

AgentPier has always run native coding CLIs with the host user's own file
permissions, and both `README.md` and `docs/architecture.md` state plainly that
profile separation is configuration isolation rather than an operating-system
sandbox. nono is an external capability-based sandbox that can wrap an arbitrary
command, so we decided to offer it as an opt-in per-session confinement layer: a
session that names a sandbox profile is launched as `nono wrap` around the CLI,
and every other session keeps today's behaviour unchanged.

## Considered options

Adding nono as a fourth coding CLI was rejected outright. nono holds no model
conversation, so it cannot occupy the same slot as Codex, Claude Code or OpenCode.
It is registered only as a supporting binary for detection, alongside `gh`.

Running the whole AgentPier server under nono was rejected because it applies one
policy to every session at once and removes the per-session choice that motivated
the feature.

Wrapping inside `server/terminal-launcher.js` was rejected in favour of wrapping
while the launch description is composed. The launcher is a documented
compatibility boundary referenced by persisted launch files, and composing earlier
means the existing executable validation in `SessionManager` applies to the nono
binary, and session replacement inherits the sandbox from the stored launch
description with no extra work.

A fully resolved `nono --config` manifest was rejected because that flag is
mutually exclusive with all other sandbox configuration, which would discard the
user's own sandbox profile and its registry packs. Grants are instead passed as
flags layered on top of a named sandbox profile.

Letting one module infer the whole grant set centrally was rejected because it
duplicates path knowledge that the individual launch adapters already own. When an
adapter later changes a path, a central copy rots silently and the symptom is a
runtime denial rather than a failing test. Each adapter therefore declares its own
grants and the nono adapter consumes them.

## Consequences

The confinement is deliberately partial. Full integration parity requires granting
the CLI read-write access to each active integration's own subtree of the AgentPier
data directory — never the data directory as a whole, and never the install
directory as a whole either — plus read access to `server/`, `vendor/`,
`node_modules/` and the Node binary, because project memory, AgentBus, the SSH
tools and the GitHub credential helper all run as subprocesses the CLI itself
spawns. A sandboxed session is therefore meaningfully confined against accident,
but it is not a boundary against a hostile CLI. Documentation must claim the
former and not the latter.

Codex is wrapped as well, which nests nono around Codex's own sandbox mode. Two
independent layers can each deny an access, and `server/lib/sandbox.js` already
records that Codex's layer ignores unusable grants silently while the session still
looks healthy. Misconfigured grants for Codex will be harder to diagnose than for
Claude Code or OpenCode.

`runSandbox()` reports `none` for Claude Code and OpenCode and publishes that value
to the agent as `AGENTRUNNER_SANDBOX`. This work gives it the ability to report
`"nono"` instead, but its only caller still passes `null`, so no session path
reaches that branch yet: the published value stays `none` for every session today.

Login sessions cannot be sandboxed, because they depend on a browser handoff that
confinement breaks. Pipelines are out of scope for the first version: their stages
run headless in worktrees and cannot answer nono's interactive save-profile prompt.

Sandbox profiles may extend signed packs from nono's registry. That introduces a
supply-chain surface this project has not previously had.
