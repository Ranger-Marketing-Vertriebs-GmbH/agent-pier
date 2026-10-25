# Secrets

A secret is a named value, such as an API token, that agents and coding sessions need to call a service. AgentPier stores it once and hands it to the agents and sessions that should have it, as a file. It never puts a value into an environment variable, a prompt, a log or an ordinary backup.

## Manage secrets

In **Settings → Access → Secrets**, select a secret to open its details alongside the list, or choose **New secret**. A secret has:

- **Name**: capital letters, digits and underscores, starting with a letter or an underscore, up to 64 characters, for example `ZABBIX_TOKEN`. Names are unique across all secrets.
- **Description**: up to 200 characters.
- **Project**: **Global** or one project. Coding sessions in a project receive its project secrets automatically. A global secret reaches only the agents and sessions you assign it to.
- **Value**: 1 to 8192 bytes of UTF-8 text without NUL characters, entered on one line; multi-line values are not supported in the UI yet. After saving, the page shows **Value saved** with **Replace value** and **Keep saved value**. The value is never shown again.

You can keep up to 200 secrets. **Delete** asks for confirmation; agents and sessions lose the secret at once. Switching to another secret with unsaved changes asks first. The page warns that agents and sessions that receive a secret can read its value, so use tokens with the fewest rights the task needs.

Managing secrets is an owner operation. The API (`/api/secrets`) never returns values.

## Agents

Open **Agents → Settings → Work → Secrets** and select the secrets this agent receives, up to 50 per agent. AgentPier delivers them as `.agentpier/secrets.env` in its workspace. While at least one secret reaches the agent, its AgentPier instructions (`AGENTS.md`) name this file, tell it to load it in the same shell command with `set -a; . .agentpier/secrets.env; set +a`, and never to print, log, commit or paste the values. The instructions contain no secret names or values, and the line disappears once nothing is granted. A grant change reaches the instructions before the agent's next turn.

- The file has the line `# Managed by AgentPier. Do not edit; changes are overwritten.` followed by one line per secret, sorted by name: `NAME='value'`, with every `'` in a value written as `'\''`. It has mode 0600 and can be loaded by a POSIX shell without expansion.
- AgentPier rewrites the file at once when a value, a selection or a grant changes, and again before every turn. A deleted secret or a revoked grant disappears from the file immediately. The file is removed when nothing is granted, or when the agent is archived or becomes an agent of a user.
- OpenClaw 2026.10.7 masks the values as `***` in the results of its read tool. An agent uses a secret through the shell: `set -a; . .agentpier/secrets.env; set +a`, then for example `curl`.
- The agent's file tools (`write`, `edit`, `apply_patch`) refuse any change below `.agentpier/` in every turn, the owner's included, with "Files in .agentpier are managed by AgentPier." Agent SFTP transfers, browser uploads and file shares refuse that folder as well ([details](assistant-gateway.md#security-boundaries)).
- **The shell is not covered.** Agents run as your operating-system user without a sandbox, so an agent with a shell can read and change any of your files, including this one. AgentPier writes the file again before the agent's next turn.
- Workspace backups leave `.agentpier/secrets.env` out; see [Backups](backups.md#secrets-in-backups).

### Who receives secrets

Only your own agents and their permanent team members. Never:

- agents of restricted users (**Users**); the picker is locked for them;
- temporary team members and archived agents;
- agents with their own Telegram bot for other people. The picker is disabled with a note, and connecting such a bot is refused for an agent that has secrets.

A grant left over from before an agent lost eligibility delivers nothing.

## Coding sessions

Every Codex, Claude Code, OpenCode and shell session gets a file at `<data>/secrets/sessions/<sessionId>/secrets.env` (folder 0700, file 0600), outside the checkout. Login sessions and headless pipeline sessions do not receive secrets. The environment variable `AGENTPIER_SECRETS_FILE` holds the path, never a value, and a sandboxed session gets read access to the folder ([sandbox](sandbox.md)).

The file contains:

- the secrets of the session's project, and
- the secrets you ticked in the new-session dialog. It lists all secrets as optional, with their owner shown; the note there says that the session's own project secrets are always included.

Choose secrets only when you launch a session. A login session refuses the choice, and launches from a task profile have no picker. After launch, the file follows changes to project secrets and values at once and is removed when the session stops or is removed. A project rebind after `git init` moves the project secrets along ([SSH accesses](ssh-access.md#git-initialization-in-a-session-folder)).

Claude Code and Codex receive a startup hint through a SessionStart hook, OpenCode through a plugin. It names the file and the command `set -a; . '<path>'; set +a`. Shell sessions get only the environment variable. The hint is shown only when the file has secrets at session start; a session without its own SSH tools gets the hook only then. A project secret added to a session that had none appears in the hint after [Reload & resume](session-reload.md); the file itself is updated immediately.

## Trust model

Agents and sessions see the values they receive; AgentPier has no proxy that hides them. Create a dedicated token with minimal rights for each use and revoke it at its service when an agent should lose access for good.

## Storage and audit

Values live in `<data>/secrets/secrets.sqlite`, a file with mode 0600 in a 0700 folder. They are not encrypted at rest, like the values of MCP servers ([MCP](mcp.md)). The delivered files are plaintext as well.

The audit log records `secret.created`, `secret.updated` and `secret.deleted` with the name and the names of changed fields, and `assistant.updated` with kind `secret-grants` and the secret names for agent grants. It never contains values, and reading a secret is not recorded.

## Backups

Ordinary backups leave secrets out. A backup with a passphrase and **Include encrypted credentials** seals them in the capsule; restoring needs AgentPier 2.7.0 or newer. See [Secrets in backups](backups.md#secrets-in-backups). The delivered files are never backed up.

## Not included yet

- Multi-line values such as PEM keys in the UI. The value field takes one line; the API and the delivered file support multi-line values.
- A per-webhook **Secrets** switch, once webhooks (AGENTPIER-216) are available.
- Changing a running session's explicitly chosen secrets. Project secrets already follow changes live.
- A secrets picker for launches from a task profile.
