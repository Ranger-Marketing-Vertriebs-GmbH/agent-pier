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
  and length, never its text or output. The text stays in the approval, in the
  agent's transcript and (amended 2026-10-23, up to 8 KiB) in a trusted run's action
  row, so its chat note can show the whole command.
- **Only permanent agents.** Temporary members never hold grants; grants are never
  inherited from a lead; bots for other people refuse agents with grants. (Amended
  2026-10-17, see below.)

## Consequences

- **Residual prompt-injection risk of trusted modes.** A turn that read web pages,
  documents, MCP output or remote output can run commands on `trusted` hosts without a
  card. The mode picker warns about this; `approval` is the default. A taint-based
  downgrade through the plugin's `before_tool_call` guard is a possible follow-up.
- **Not a sandbox.** This is convenience scoping under one OS user. An agent with full
  shell can still read `<data>/ssh/identities`.
- Removing a host revokes agent grants first; a crash between the two steps leaves an
  inert grant that every read filters out.

## Amendment 2026-10-17: a lead may grant its members SSH by an explicit setting

The owner decided that lead agents grant their temporary team members tools and
access within their own capabilities (AGENTPIER-112). SSH stays excluded by default
and needs an explicit choice:

- Only while the lead's **Work → Team members may use shell and SSH** (off by
  default) is on may the lead grant a temporary member `ssh`, in the team proposal
  or later. A proposal with such a grant always waits for the owner's approval, and
  a later SSH grant always becomes an owner card (web and Telegram); neither applies
  before the owner approved.
- A member still holds no grant of its own: it runs `agentpier_ssh` on the lead's
  grants, every check (`AssistantAccess.sshHolder`) reads the lead's current grants,
  and the member is a delegated caller, so `approval` hosts ask the owner (also in
  the lead's chat) and `trusted` hosts run without a card.
- The setting is recorded with each team at its proposal and read live: only teams
  proposed while it is on can use it. Switching it off latches: the teams lose it
  for good, their members' SSH grants are removed and pending cards are cancelled;
  the lead revoking the grant or losing its own SSH grants also revokes it for
  running members. The proposal (web and Telegram) marks members granted SSH with a
  warning.
- Consequence: an unattended lead or member that read untrusted content could be
  steered into granting or using SSH on the lead's `trusted` hosts. The ceiling, the
  owner's approval for later grants and the visible grant notes limit this; the
  residual risk above applies to members as well.
