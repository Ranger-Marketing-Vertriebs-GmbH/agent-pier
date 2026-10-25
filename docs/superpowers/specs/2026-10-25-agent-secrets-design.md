# Secrets for agents and coding CLIs — design

Date: 2026-10-25. Owner request, discussed in chat (German). "Owner" marks what the owner
decided; "call" marks the controller's choice, shown to the owner.

## Intent

Many systems the owner runs have no MCP server but an HTTP API with a token, for example
Zabbix and Home Assistant. Agents and coding CLIs should be able to call such APIs themselves,
for example an agent woken by a Zabbix webhook (AGENTPIER-216) that then fetches the problem
details with `curl`. The owner rejected a token-hiding API proxy as over-engineered and wants
the simple version (owner): AgentPier stores named secrets and hands them to agents and CLIs
as a read-only `.env`-style file, "like a Plane token for the Plane MCP".

## Decisions

- **Secrets are simple name/value entries** (owner), e.g. `ZABBIX_URL`, `ZABBIX_TOKEN`,
  `HA_URL`, `HA_TOKEN`. URLs are just further entries. Names follow env-var syntax
  (`[A-Z_][A-Z0-9_]*`, call). An optional description per entry (call).
- **Delivered as a file only, never as environment variables** (owner, on the controller's
  recommendation): env vars are inherited by every child process and leak through `env`, crash
  reports and logs; a file is read on purpose and updates take effect immediately.
- **Agents cannot change the file** (owner): it is read-only for the agent; AgentPier's write
  guard refuses writes, edits and deletes like it does for bootstrap files.
- **The agent/CLI sees the values.** No proxy, no redaction, no approval levels. Protection comes
  from the token itself (least privilege); the docs say so plainly (owner accepted the trade-off).
- **Where:** **Settings → Access → Secrets** (call), list/detail pattern of the ui-guide. A value
  is shown masked after saving and can be replaced, never read back in the browser (call; keeps
  values out of browser responses per AGENTS.md).
- **Agents:** the owner picks per agent which secrets it gets (call: in the agent's settings, like
  SSH hosts). AgentPier writes them to one file in the agent's workspace, e.g.
  `.agentpier/secrets.env` (exact path left to the builder), mode 0600/0400, and rewrites it at
  once when a value, the selection or the agent's grant changes; removes it when nothing is
  granted.
- **Coding CLIs:** the owner assigns secrets to a project (call: project-owned or global plus
  session assignment, like SSH accesses). Sessions of that project find them in a file outside
  the repository (never inside the checkout, so they can't be committed), readable only by the
  owner's user; the session start hint names the path and how to load it
  (`set -a; . <path>; set +a`).
- **Who:** the owner's agents and permanent team members (granted by the owner). Restricted
  users' agents and sessions, and temporary members: none in this version (call).
- **Webhook runs (216):** a hook run reads files with the run's reduced rights; whether the
  secrets file is readable in a hook run follows a per-hook switch "Secrets", default off (call;
  only if 216 has merged when this is built, otherwise a follow-up).
- **Backups:** values are stored encrypted like other credentials and included only in backups
  with credentials, sealed like SFTP passwords and model keys (call). The delivered files are
  derived data, not backed up.
- **Audit:** creating, changing, deleting and granting secrets is audited by name, never value.
  Reads are not audited (they are plain file reads).

## Constraints

- AGENTS.md: values never in Git, logs, audit, browser responses or tool results produced by
  AgentPier itself; disposable data dirs in tests; files ≤ 600 lines; de/en i18n with
  translation-lock; ui-guide components only; docs updated in the PR (new `docs/secrets.md`,
  README feature list, agents/workflow docs, backups doc).
- Agents run on OpenClaw 2026.10.7; the write-guard refusal for the secrets file needs a native
  contract on 10.7.
- The file format must be safe to `source` in sh/bash: values quoted so that no shell
  expansion happens (single quotes with `'\''` escaping) (call).

## Anti-goals

- A secret value in a browser response, log, audit entry, Git checkout or AgentPier-generated
  message.
- An agent able to modify or delete its secrets file, or to read another agent's.
- A permission system per secret beyond "granted or not".

## Left to the builder

Storage module, exact file paths, how the CLI session learns its path (hint text / existing
startup hint composition), UI details within the ui-guide, test strategy (unit, integration with
disposable dirs, browser test for the settings page, native contract for the write guard).
