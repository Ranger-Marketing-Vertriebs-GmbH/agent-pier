# SSH server accesses

AgentPier manages SSH keys and hosts for projects and individual sessions. Local Codex, Claude Code and OpenCode sessions can provision project access through MCP. Shell sessions can use the manual SSH helper. The CLI continues to run on your computer.

## Project ownership and session assignments

A project's hosts are available to its existing and future supported interactive sessions. Git checkouts and their worktrees share a project; separate clones remain separate. An ordinary launch directory is also a project, including a nested directory selected as its own launch root. SSH project binding works independently of the Memory setting.

The project is bound when the session launches. Running `cd` does not change it. AgentPier checks the canonical launch directory and its filesystem identity, as well as the Git common-directory identity where applicable. A removed, replaced or changed project directory requires a new binding; it cannot silently acquire another project's records. This also applies to replacing a worktree at the same path.

In **Settings → Access → SSH accesses**, use the **Accesses** and **Keys** tabs to browse compact lists. Search by name, host, username or project, and combine the search with the project filter. Lists show 20 entries per page. Select an entry to open its details alongside the list; on narrow screens, close the details to return to the list. Host fingerprints stay collapsed until opened. Connection tests and private-key downloads still require an explicit action.

Select the project when creating keys or hosts. The current project filter preselects ownership for new entries. A project host must use a key owned by the same project. Existing global entries remain global. Explicit session assignments add access to selected global or other-project hosts without transferring key ownership. The session picker marks inherited hosts as **Project**; manage those hosts in settings. Removing an explicit assignment does not remove independently inherited project access.

### Git initialization in a session folder

One identity change keeps a running session's project: its launch folder was a plain directory and became the root of its own Git work tree, for example after `git init`. AgentPier applies this rebind only when all of the following hold:

- The folder has the same canonical path, device and inode as at launch.
- Git reports that folder as the work-tree root.
- The Git common directory is the folder's own `.git` directory. It must not be a symlink, a separate Git directory, a linked worktree or a parent repository.

Out-of-process SSH tools keep using the launch project ID until the server rebinds the session, so no access is added. The first server-side SSH management call or artifact publication moves the project to its Git identity, along with:

- memory entries, request receipts and session capabilities;
- SSH keys, hosts and their request receipts;
- artifact records and pipeline verification steps;
- the SSH binding of every session launched in that folder.

The move is refused when the Git identity already owns memory entries, SSH keys or SSH hosts, for example after an older `.git` directory was restored. The session then keeps only its launch project's SSH access. A rebind is recorded once, as the `project.updated` audit event, and a folder never rebinds to a second Git identity. If a move is interrupted, or another session registered the new identity first, the next artifact publication finishes it. An SSH management call finishes it only for a session that is still bound to the plain project ID. Verification steps merge into steps the Git project already has: missing steps are appended in order without duplicates, within the step limits. Session and OAuth grants that named the plain project follow it to the new identity; agent project access does not ([agent workflows](assistant-workflows.md#project-access-and-actions)).

After the move, the project follows Git project rules: its hosts, keys and memory are also reachable from subdirectories and linked worktrees of the new repository.

Every other change is rejected as before: a replaced folder, Git to plain directory, a different root or another common directory. Artifact tools answer "The project of this session changed. Reload the session to continue." (`ARTIFACT_PROJECT_CHANGED`), SSH answers `SSH_PROJECT_CHANGED` with "The project of this session changed. Reload the session to keep using SSH.", and server-side denials are audited as `artifact.denied` and `ssh.denied`. Removing `.git` stays strict, because a Git identity can be shared by linked worktrees and clones of the same common directory, so splitting it into a directory project is not equally safe.

Owner-only project reassignment moves the project's resources together. Colliding key identities or host endpoint/user combinations reject the whole move. The source project's sessions lose inherited access and the target project's sessions gain it; explicit assignments remain separate. Reload affected sessions to bind them to a changed launch project.

## Manage named keys

Create a named SSH key in settings. Generate a dedicated Ed25519 key or import an unencrypted OpenSSH private key. Pasted keys tolerate missing final newlines, CRLF line endings and surrounding whitespace. Passphrase-protected keys remain unsupported.

Names can be changed without changing the key or its host assignments. One key may be selected by multiple hosts; its entry shows the hosts using it. A referenced key cannot be deleted. To rotate a key, create a replacement, select it on the relevant hosts, then delete the unused old key. Deleting a host leaves its reusable key available. Editing, rotation, deletion and ownership changes are owner UI operations.

Ordinary API results and every MCP result contain public metadata only. **Download private key** is an explicit owner action in settings for generated and imported keys. It downloads the **unencrypted private key** through an authenticated POST; it does not render the contents in the page. Protect the downloaded file as a credential. No private key needs to be pasted into a conversation.

## Add a server

In the hosts section, enter a name, hostname/IP address, SSH port and username, then select a saved key.

Fetch the server's host key, compare the displayed SHA256 fingerprint with an independently trusted source such as the server console, and confirm it. Scanning alone does not authenticate a server. Save the host, copy the selected key's public key and install that public key for the intended user on the target system. **Test connection** explicitly authenticates and runs `true`; saving or assigning an access makes no remote connection.

For a Proxmox host, use an account with the permissions needed for the intended administration. AgentPier does not provision VMs simply because an access is assigned.

## Provision from a coding session

Codex, Claude Code and OpenCode receive the `agentpier_ssh` MCP integration independently of the AgentBus setting, including when the project has no hosts yet. The startup SSH hint composes with existing Memory, AgentBus and user hooks. Login sessions and headless pipeline sessions do not receive this integration; shell sessions have the manual helper without a model hint.

The provisioning sequence is:

1. Discover project keys with `ssh_list_keys` and effective hosts with `ssh_list_hosts`.
2. Use `ssh_generate_key` or `ssh_import_key`, then retrieve the public key with `ssh_get_public_key`.
3. Install the public key using an already authorized SSH access or a provider console/API. Preserve existing authorized keys and use the intended remote account. There is no automatic installer or password bootstrap.
4. Verify the target host key through an independent trusted channel. `ssh_scan_host` returns an unverified observation. `ssh_register_host` requires a supplied pin and provenance from an assigned pinned access, provider verification or user verification. Stop and obtain trusted verification when none is available.
5. Register the project host, call `ssh_test_host`, then use `ssh_execute` for authorized work.

Import accepts a local absolute path or `~/...`, including a key outside the project. It copies an unencrypted key into managed storage and leaves the source bytes and permissions unchanged. It rejects final-component symlinks, special files, oversized inputs and managed AgentPier identities. Matching public identities within the same project reuse the existing key. MCP never accepts or returns private-key contents.

Generation, import and registration require a caller-generated `requestId`. After an uncertain connection outcome, retry the same operation with the same request ID and input. A committed import retry does not reread a changed or missing source. Changing the input conflicts. Deleting or reassigning the resulting resource makes its old request receipts terminal; retries cannot recreate it or transfer authority. Host registration reuses an identical saved connection and rejects conflicting keys or pins that require an owner UI change.

## Session lifecycle and manual access

Select explicit accesses in the new-session dialog, or open **SSH accesses** in an existing running session. The dialog reports whether the tools are ready, still starting, or require **Reload & resume**. Existing CLI processes need [Reload & resume](session-reload.md) to acquire new tool schemas and startup hints while retaining their native conversation. Once updated, later project and explicit assignment changes take effect on the next call without another reload.

The explicit connection command remains available as a manual fallback, including for shell sessions. Append ` -- <remote command>` to run a command, or invoke the helper alone for an interactive SSH shell. Native shell/network approvals may still apply.

No remote command is automatically run when an access is assigned or a session is reloaded. Capabilities rotate for each CLI launch. Each call checks the current session and effective grants; MCP execution also checks revocation and connection revision periodically. An already-started manual SSH connection may continue after revocation. Stopping/removing a session clears its ephemeral assignments, while project resources remain. Reloading and restarting only the AgentPier web service preserve compatible session bindings and explicit assignments.

## Existing configurations and upgrades

The application service migrates legacy keys and hosts into one private SSH catalog. Host IDs, reusable keys, identity files and explicit session grants are preserved; legacy records remain global and are not automatically shared with a project. Older per-host identities are deduplicated by canonical public identity when converted to reusable keys.

The first unified-catalog migration invalidates persisted SSH capabilities. Existing coding sessions require **Reload & resume**. Ordinary subsequent service restarts preserve compatible capabilities. Migration records its cutover phase so an interrupted startup can recover, publishes the new catalog atomically, and archives the old active `keys.json` and `accesses.json` files as `.legacy` files. It does not read personal `~/.ssh/config` or scan unrelated keys.

Stop the old service before upgrading; concurrent old and new catalog writers are unsupported. Installations with a unified SSH catalog cannot downgrade to releases that do not support it. The earlier reusable-key catalog's version 1.8 minimum is insufficient for this format.

## Agents

Agents use SSH accesses through AgentPier, never through the session MCP server. Grant
hosts per agent under **Agents → Settings → Work → SSH accesses** and choose a mode:
**With approval**, **Trusted** or **Trusted incl. routines** (see
[agents](agents.md#work)). Any host can be granted, global or project-owned; the
project badge only says where the key lives. Temporary team members never hold SSH
accesses of their own. A lead can grant them SSH on its own accesses only while
its **Work → Team members may use shell and SSH** is on, for teams proposed while it
is on; a later SSH grant waits for the owner's approval (see [agents](agents.md)).

The agent's `agentpier_ssh` tool can list its granted hosts and run one command at a
time; it cannot create, import, scan, test or download keys or hosts. AgentPier runs
the command with the same pinned connection as sessions (`-F /dev/null`, only the
pinned host key, no agent forwarding), with at most 16 KiB of command, 120 seconds and
64 KiB of output. Removing a host here first revokes it from every agent and cancels
its open approvals. Editing a host's address, port, user, key or pin stops running
commands on it, and its open approvals can no longer run: allowing one marks it
**Access changed**. The activity log records `ssh.executed` and `ssh.denied` with a
SHA-256 digest and length of the command, never its text or output.

Every finished run leaves a note in the chat it ran from, in **With approval** mode as
well as in the trusted modes; a denied, expired or cancelled request leaves none. The
note is an activity row with the host, the shortened command and its outcome; opened,
it shows the whole command with a copy button, the exit code and the duration. Trusted
runs therefore keep up to 8 KiB of their command with the action, the newest 500 per
agent (runs from before this change kept only an 80-character preview); the output is
never stored. Recognisable secrets (password, token and key flags, `Authorization`
and API key headers, `user:password@` URLs, variables such as `DB_PASSWORD=`, JWTs and
well-known key prefixes) are stored as `•••`, best effort: a trusted run's at once, an
approval's once it has run or was declined, expired or cancelled, since the owner
decides on the exact text. The row then says **Secrets hidden**.

Downgrading to a release without agent SSH keeps the stored SSH rows but no longer
understands them. Such a release shows a finished run's note as a generic coding-run
note without project or pipeline, and a waiting SSH request as a generic memory-proposal card
without the command. Allowing that card cannot run the command: the older release
checks it as a project action, finds no project grant and marks it failed. Commands
that were running when the service stopped are marked as unknown on its next start.
The grants themselves stay stored and take effect again after upgrading.

## Scope and storage

This is convenience scoping under one OS user, **not an operating-system sandbox**. Processes with that user's filesystem permissions may read the same private files. Use OS/container isolation when that must be prevented. Existing personal `~/.ssh` access is not revoked or changed.

Private keys live in owner-only files (0600) under `AGENTPIER_DATA_DIR/ssh/identities`, inside owner-only directories (0700). The versioned `ssh/catalog.json` contains keys, hosts, project records and mutation receipts. The application owns catalog writes through a private local management socket; standalone MCP/helper processes read published state and delegate mutations. Prepared identities use `ssh/staging`; each connection receives an immutable pin snapshot under `ssh/connections` and cleans up its own snapshot.

Catalog publication is atomic. Receipts are retained, with a 16 MiB limit on new catalog growth; deletion and size-reducing changes remain available. Legacy migration preserves oversized catalogs instead of dropping records. Generated keys are unencrypted at rest and rely on local account/filesystem protection. Private bytes are excluded from ordinary responses, prompts and audit records; the explicit authenticated owner download is the export path. Host keys are pinned, and the managed helper disables inherited SSH configuration, other agents, password fallback, agent forwarding and connection multiplexing.

SSH accesses, private keys, project records, receipts and session grants are **omitted from AgentPier backups**, including backups with credentials. Keep an independent secure key backup through the owner download or retain imported source keys. Do not put the runtime SSH directory into Git.

OpenSSH (`ssh`, `ssh-keygen`, `ssh-keyscan`) must be installed on the AgentPier host. No Proxmox-specific integration, jump-host configuration or remote CLI hosting is included.
