# SSH server accesses

AgentPier can assign SSH server accesses to a local Codex, Claude Code, OpenCode or shell session. The CLI continues to run on your computer. Assignments can be added or removed after the session starts.

## Manage named keys

Open **Settings → Server accesses** and create a named SSH key. Generate a dedicated Ed25519 key or import an unencrypted OpenSSH private key. Pasted keys tolerate missing final newlines, CRLF line endings and surrounding whitespace. Private key bytes are never returned by the API.

Names can be changed later without changing the key or its host assignments. One key may be selected by multiple hosts; its entry shows the hosts using it. A referenced key cannot be deleted. To rotate a key, create a replacement key and select it on the relevant hosts, then delete the unused old key. Deleting a host leaves the reusable key available. Passphrase-protected key import remains unsupported.

## Add a server

In the hosts section, enter a name, hostname/IP address, SSH port and username, then select a saved key.

Fetch the server's host key, compare the displayed SHA256 fingerprint with an independently trusted source (for example the server console), and confirm it. Scanning alone does not authenticate a server. Save the host, copy the selected key’s public key and install that public key for the intended user on the target system. **Test connection** explicitly authenticates and runs `true`; saving or assigning an access makes no remote connection.

For a Proxmox host, use an account with the permissions needed for the intended administration. AgentPier does not provision VMs simply because an access is assigned.

## Use an access in a session

Select accesses in the new-session dialog, or open **Server accesses** in an existing running session. Save the selection, then copy the displayed connection command into your message to the coding agent. Append ` -- <remote command>` to run a command, or use the helper alone for an interactive SSH shell. The helper is a local Node/OpenSSH executable and may require the CLI's normal shell or network approval.

No message or keystroke is automatically injected into the running CLI. The helper checks the session identity and current assignment for every invocation. Removing an assignment blocks the next helper invocation; SSH connections already established continue until closed. Stop/remove reconciliation clears the session's assignments. Assignments survive an AgentPier web service restart while the native session continues.

## Existing configurations

Existing AgentPier SSH accesses are separated automatically into named keys and hosts. Identical canonical public keys are combined into one reusable key entry. Host IDs and session assignments remain unchanged. Migration preserves the original key files and can be retried after an interruption; it does not import your personal `~/.ssh/config` or scan unrelated keys. Rename imported key entries to suit your naming scheme.

Versions before 1.8 do not understand the reusable key catalog. Use version 1.8 or newer for hosts created or reassigned with this feature.

## Scope and storage

This is targeted assignment, **not a sandbox or security boundary between processes running as the same OS user**. Such processes may read the same private files or invoke a helper using another session's identity. Use OS/container isolation if that must be prevented. Existing personal `~/.ssh` access is not revoked or changed.

Private keys are stored in owner-only files (0600) under `AGENTPIER_DATA_DIR/ssh/identities`, inside owner-only directories (0700). Host-specific known-hosts files remain under `ssh/keys`; the public key catalog is `ssh/keys.json`. They are not sent back in API responses, embedded in connection commands or included in prompts/audit entries. Generated keys are unencrypted at rest and rely on the local account/filesystem protection. Host keys are pinned; the managed helper disables global SSH configuration, other agents, password fallback, agent forwarding and connection multiplexing.

SSH accesses, private keys and session assignments are explicitly **omitted from AgentPier backups**, including backups with credentials, in this initial version. Keep an independent secure copy of imported keys or plan to replace generated keys after a machine loss. Do not put the runtime SSH directory into Git.

OpenSSH (`ssh`, `ssh-keygen`, `ssh-keyscan`) must be installed on the AgentPier host. No Proxmox-specific integration, jump-host configuration or remote CLI hosting is included.
