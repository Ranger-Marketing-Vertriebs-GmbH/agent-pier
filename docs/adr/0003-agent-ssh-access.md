# SSH access for agents

---

Status: agreed; implemented (off until the owner grants a host).

Date: 2026-10-16

---

## Context

Agents can already run shell commands, and an agent with full shell access can use the
owner's `~/.ssh`. The owner wants agents to work on servers they pinned in
**Settings → Access → SSH accesses** — with the key, the host-key pin, the grant, the
approval and the audit under AgentPier's control — and to decide per agent and per host
how much supervision applies.

## Decision

- **A bridge tool, not MCP.** `agentpier_ssh` is a tool of the `agentpier-teams`
  plugin. It calls AgentPier's loopback bridge, which knows the caller from the ledger
  attempt. The `agentpier-ssh` MCP server stays session-only, and agents get no key or
  host management.
- **Three modes per granted host.** `approval` asks for every command (Allow once or
  Deny, no "always"); `trusted` runs without a card in owner and paired-Telegram turns
  and in turns the lead delegated or asked; `routines` also runs in the agent's own
  routine runs. Forwarded content, member results, reminders, check-ins and unknown
  turns never reach SSH, and a routine may use only `routines` hosts.
- **Digest-only audit.** `ssh.executed` and `ssh.denied` store the command's SHA-256
  and length, never its text or output. The text stays in the approval and in the
  agent's transcript.
- **Only permanent agents.** Temporary members never hold grants; grants are never
  inherited from a lead; bots for other people refuse agents with grants.

## Consequences

- **Residual prompt-injection risk of trusted modes.** A turn that read web pages,
  documents, MCP output or remote output can run commands on `trusted` hosts without a
  card. The mode picker warns about this; `approval` is the default. A taint-based
  downgrade through the plugin's `before_tool_call` guard is a possible follow-up.
- **Not a sandbox.** This is convenience scoping under one OS user. An agent with full
  shell can still read `<data>/ssh/identities`.
- Removing a host revokes agent grants first; a crash between the two steps leaves an
  inert grant that every read filters out.
