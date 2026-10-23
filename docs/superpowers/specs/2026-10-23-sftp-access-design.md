# SFTP access for agents and coding CLIs

Ticket: AGENTPIER-204. Branch `feat/sftp-access`.

## Intent

The owner wants to store SFTP access (e.g. the main FTP user of a Hetzner webhosting
package without SSH shell — Hetzner offers SFTP on port 22 with user + password,
FTPS on 21; SSH shell is separate on port 222) and let agents and coding CLIs upload
and download files there, managed the same way as the existing SSH hosts
(docs/ssh-access.md; server/features/ssh/, the AgentPier SSH MCP server and agent
SSH tools in server/features/assistants/agent-ssh*.js).

## Decisions by the owner

- SFTP only for now (no FTP/FTPS).
- Credentials: user + password **or** key.
- Same management model as SSH: central hosts, verified host identity, per-agent
  grants, approvals, audit; for agents and for coding CLIs.
- Reading (list, download) runs without asking; writing (upload, overwrite, rename,
  delete, make folder) needs the owner's approval with **Allow once / Always allow for
  this host / Deny**, as for SSH commands.
- **Whole folders** can be uploaded (recursive) — one approval for the whole upload,
  showing target path, file count, total size and how many files would be
  overwritten. Whole-folder download is included too.
- **Sync** in both directions (local → server for deploys, server → local for
  backups): only new and changed files (size + mtime, optional checksum); deleting
  extra files on the target side only with an explicit option (default off); AgentPier
  computes a plan first and the approval shows it (counts and file list of new /
  changed / deleted); "Always allow" covers syncs without deletes, a sync with deletes
  always asks. Exclude patterns, with `.git` and `.env` excluded by default.
- **Coding CLIs behave like SSH today:** a host granted to the project/session may be
  used directly (no AgentPier approval card; the CLI's own permission prompt applies).
- **Passwords are stored like SSH keys:** a 0600 file in the AgentPier data dir, not in
  ordinary backups; only in credential backups sealed with a passphrase.
- Every action shows as an activity row in the chat (like the SSH rows of
  AGENTPIER-201) and is audited.

## Goals

- **Host type SFTP** in the existing host management (UI under the same place as SSH
  hosts; DE/EN): host, port (default 22), user, auth = password or managed/imported key;
  host fingerprint verified like SSH (scan + trusted fingerprint confirmation);
  connection test. Passwords stored encrypted like other secrets; never sent to
  agents, logs, browser responses or audit.
- **Operations** (server-side, via an SFTP client library or the system `sftp`
  binary — builder's choice, provisioned through the install/update path if a new
  runtime dependency is needed): `list`, `stat`, `download` (file or folder,
  recursive), `upload` (file or folder, recursive, creates folders, overwrites),
  `mkdir`, `rename`, `delete` (file or empty folder; recursive folder delete only with
  an explicit flag and approval).
- **Local side:** transfers go to/from the agent's workspace or a project folder the
  agent may read (download) / write (upload source must be readable; download target
  must be writable) — same path checks as project folder access (no links out,
  protected roots). For coding CLIs, the session's project folder.
- **Limits:** per-transfer size cap and file-count cap (builder picks and documents,
  e.g. 2 GB / 10,000 files), timeouts, progress for long transfers, cancellation.
- **Access:** per-agent SFTP host grants like SSH grants (owner grants; leads may share
  with permanent members only if leads can share SSH hosts today — follow the SSH
  rule); temporary members follow the SSH inheritance rules. Coding CLIs get the tools
  through the AgentPier SSH MCP server (new `sftp_*` tools) with the same per-host
  approval model.
- **Approvals:** write operations create an approval card (chat + Telegram like SSH),
  with a clear summary (operation, host, remote path, file count, size, overwrites).
  "Always allow" is per host and per agent, revocable.
- **Visibility:** activity rows (ActivityRow from AGENTPIER-201) with expandable
  details (paths, counts, bytes, duration, result); audit entries without secrets.

## Calls made during the design (builder check)

- **Storage:** SFTP hosts are a new host type in the existing unified SSH catalog
  (same project scoping, keys, pins/fingerprints, receipts); an SFTP host may share
  address/user with an SSH host; SFTP hosts appear in `ssh_list_hosts` with their type
  and in the session host picker.
- **Client:** a pure-JS SFTP client library (e.g. `ssh2`) — non-interactive password
  login and host-key pinning in-process, no password in argv/env/process list, no
  `sshpass`; provisioned as a normal npm dependency.
- **Agent sharing:** exactly the SSH rule — owner grants per agent; leads never share
  SFTP with permanent members; temporary members inherit only under the existing
  **Team members may use shell and SSH** toggle; approvals as for SSH (owner, shown in
  the agent's chat and Telegram).
- **Local paths:** uploads need read level, downloads and server→local sync need
  read-and-write level on the workspace/project folder (project-folder access rules);
  for CLI sessions the session's project folder is the root. A download never
  overwrites a local file without write level; overwrites are listed in the result.
- **Remote root:** optional per host ("allowed remote folder"); when set, every remote
  path is confined to it (no `..` escape, symlinks resolved server-side checked).
- **Always allow** (per host, per agent, revocable) covers upload, overwrite, mkdir,
  rename and sync without deletes; any delete (file, folder, sync deletes) always asks.
- **Long transfers** run as background jobs with progress and cancel; the tool returns
  a job id and a status tool reports progress; the activity row updates live. Size and
  file-count caps are checked on a pre-scan before the approval card.

## Non-goals

- FTP/FTPS, shell commands
  over SFTP hosts, resumable partial transfers (simple retry is enough).

## Anti-goals

- A password or key reaching an agent, a CLI, a log, a browser response or a backup
  in plaintext.
- Writes without approval unless the owner chose "Always allow" for that host.
- Path escapes on either side (remote `..` beyond the granted root if a root is set;
  local links out of the workspace/project).

## Constraints

- AGENTS.md rules: DE/EN UI text with i18n:confirm, UI guide components, files ≤ 600
  lines, new runtime tools provisioned via install/update scripts.
- Docs: docs/ssh-access.md (or a new docs/sftp-access.md linked from it),
  docs/agents.md, docs/assistant-gateway.md, README feature lists.
- Tests: unit/integration against a local SFTP test server fixture (no real hosts),
  browser tests for host form, approval card and activity rows.

## Left to the builder

- Library vs. system binary, exact tool names and schemas, limits, optional remote
  root restriction per host, progress UI details.
