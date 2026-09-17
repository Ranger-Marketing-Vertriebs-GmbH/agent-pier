# SSH server accesses

AgentPier manages SSH keys and hosts for projects and individual sessions. Local Codex, Claude Code and OpenCode sessions can provision project access through MCP. Shell sessions can use the manual SSH helper. The CLI continues to run on your computer.

## Project ownership and session assignments

A project's hosts are available to its existing and future supported interactive sessions. Git checkouts and their worktrees share a project; separate clones remain separate. An ordinary launch directory is also a project, including a nested directory selected as its own launch root. SSH project binding works independently of the Memory setting.

The project is bound when the session launches. Running `cd` does not change it. AgentPier checks the canonical launch directory and its filesystem identity, as well as the Git common-directory identity where applicable. A removed, replaced or changed project directory requires a new binding; it cannot silently acquire another project's records. This also applies to replacing a worktree at the same path.

In **Settings → SSH accesses**, use the **Accesses** and **Keys** tabs to browse compact lists. Search by name, host, username or project, and combine the search with the project filter. Lists show 20 entries per page. Select an entry to open its details alongside the list; on narrow screens, close the details to return to the list. Host fingerprints stay collapsed until opened. Connection tests and private-key downloads still require an explicit action.

Select the project when creating keys or hosts. The current project filter preselects ownership for new entries. A project host must use a key owned by the same project. Existing global entries remain global. Explicit session assignments add access to selected global or other-project hosts without transferring key ownership. The session picker marks inherited hosts as **Project**; manage those hosts in settings. Removing an explicit assignment does not remove independently inherited project access.

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

## Scope and storage

This is convenience scoping under one OS user, **not an operating-system sandbox**. Processes with that user's filesystem permissions may read the same private files. Use OS/container isolation when that must be prevented. Existing personal `~/.ssh` access is not revoked or changed.

Private keys live in owner-only files (0600) under `AGENTPIER_DATA_DIR/ssh/identities`, inside owner-only directories (0700). The versioned `ssh/catalog.json` contains keys, hosts, project records and mutation receipts. The application owns catalog writes through a private local management socket; standalone MCP/helper processes read published state and delegate mutations. Prepared identities use `ssh/staging`; each connection receives an immutable pin snapshot under `ssh/connections` and cleans up its own snapshot.

Catalog publication is atomic. Receipts are retained, with a 16 MiB limit on new catalog growth; deletion and size-reducing changes remain available. Legacy migration preserves oversized catalogs instead of dropping records. Generated keys are unencrypted at rest and rely on local account/filesystem protection. Private bytes are excluded from ordinary responses, prompts and audit records; the explicit authenticated owner download is the export path. Host keys are pinned, and the managed helper disables inherited SSH configuration, other agents, password fallback, agent forwarding and connection multiplexing.

SSH accesses, private keys, project records, receipts and session grants are **omitted from AgentPier backups**, including backups with credentials. Keep an independent secure key backup through the owner download or retain imported source keys. Do not put the runtime SSH directory into Git.

OpenSSH (`ssh`, `ssh-keygen`, `ssh-keyscan`) must be installed on the AgentPier host. No Proxmox-specific integration, jump-host configuration or remote CLI hosting is included.
