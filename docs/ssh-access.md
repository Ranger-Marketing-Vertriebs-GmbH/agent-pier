# SSH server accesses

AgentPier can assign SSH server accesses to a local Codex, Claude Code, OpenCode or shell session. The CLI continues to run on your computer. Assignments can be added or removed after the session starts.

## Add a server

Open **Settings → Server accesses**. Enter a name, hostname/IP address, SSH port and username. Generate a dedicated Ed25519 key or import an unencrypted private key. Encrypted key import and key rotation are not supported in this first version; create a replacement access to rotate a key.

Fetch the server's host key, compare the displayed SHA256 fingerprint with an independently trusted source (for example the server console), and confirm it. Scanning alone does not authenticate a server. Save the access, copy its public key and install that public key for the intended user on the target system. **Test connection** explicitly authenticates and runs `true`; saving or assigning an access makes no remote connection.

For a Proxmox host, use an account with the permissions needed for the intended administration. AgentPier does not provision VMs simply because an access is assigned.

## Use an access in a session

Select accesses in the new-session dialog, or open **Server accesses** in an existing running session. Save the selection, then copy the displayed connection command into your message to the coding agent. Append ` -- <remote command>` to run a command, or use the helper alone for an interactive SSH shell. The helper is a local Node/OpenSSH executable and may require the CLI's normal shell or network approval.

No message or keystroke is automatically injected into the running CLI. The helper checks the session identity and current assignment for every invocation. Removing an assignment blocks the next helper invocation; SSH connections already established continue until closed. Stop/remove reconciliation clears the session's assignments. Assignments survive an AgentPier web service restart while the native session continues.

## Scope and storage

This is targeted assignment, **not a sandbox or security boundary between processes running as the same OS user**. Such processes may read the same private files or invoke a helper using another session's identity. Use OS/container isolation if that must be prevented. Existing personal `~/.ssh` access is not revoked or changed.

Private keys are stored in owner-only files (0600) under `AGENTPIER_DATA_DIR/ssh/keys`, inside owner-only directories (0700). They are not sent back in API responses, embedded in connection commands or included in prompts/audit entries. Generated keys are unencrypted at rest and rely on the local account/filesystem protection. Host keys are pinned; the managed helper disables global SSH configuration, other agents, password fallback, agent forwarding and connection multiplexing.

SSH accesses, private keys and session assignments are explicitly **omitted from AgentPier backups**, including backups with credentials, in this initial version. Keep an independent secure copy of imported keys or plan to replace generated keys after a machine loss. Do not put the runtime SSH directory into Git.

OpenSSH (`ssh`, `ssh-keygen`, `ssh-keyscan`) must be installed on the AgentPier host. No Proxmox-specific integration, jump-host configuration or remote CLI hosting is included.
