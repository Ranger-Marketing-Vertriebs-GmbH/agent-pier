# AgentPier

AgentPier is a self-hosted workspace that hosts native coding CLI sessions on one
machine and makes them usable from a browser, including from a phone. This glossary
fixes the vocabulary the codebase and the user interface share.

## Language

### Sessions

**Session**:
One native coding CLI process, owned by an account and bound to a project directory,
running under AgentPier's private tmux server.
_Avoid_: Conversation, chat, instance.

**Launch description**:
The command, arguments and environment that a session will be started with, built by
a chain of launch adapters before the session is created.
_Avoid_: Launch config, spawn spec.

**Launch adapter**:
A step in that chain. Each one receives the launch description so far and returns it
with its own additions.
_Avoid_: Middleware, plugin, hook.

**Launch mode**:
The variant a CLI is started in, such as a work session or a login session.
_Avoid_: Session type.

### Confinement

The word _sandbox_ is load-bearing and ambiguous in this project. Never write it
unqualified; always use one of the three terms below.

**Sandboxed session**:
A session whose CLI runs inside nono, an external capability-based sandbox.
Sandboxing is opt-in per session and is not the default.
_Avoid_: Secure session, isolated session, jailed session.

**Sandbox profile**:
The nono capability policy a sandboxed session runs under, selected by name. This is
nono's own vocabulary and matches what `nono profile list` reports.
_Avoid_: Policy, profile (unqualified), ruleset.

**Codex sandbox mode**:
The operating-system confinement Codex applies to itself, independent of nono and
present whether or not a session is sandboxed.
_Avoid_: Sandbox (unqualified).

**Grant**:
A single filesystem or network capability a sandboxed session needs in order for one
AgentPier integration to keep working. Adapters declare their own grants.
_Avoid_: Permission, allowance, rule, exception.

### Profiles

_Profile_ is also ambiguous. Four unrelated things carry the name, so qualify every
use.

**Account profile**:
The isolated configuration directory that holds one account's CLI credentials and
settings.
_Avoid_: Profile (unqualified), CLI config.

**Task profile**:
The reusable CLI and model configuration a pipeline stage runs with.
_Avoid_: Profile (unqualified), stage config.

**Extension profile**:
A named selection of shared CLI skills, MCP integrations and plugins.
_Avoid_: Profile (unqualified), plugin set.

**Sandbox profile**:
See above. Belongs to nono, not to AgentPier.
