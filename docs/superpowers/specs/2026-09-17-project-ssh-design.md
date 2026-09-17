# Project SSH provisioning through session MCP

Status: adversarially reviewed; awaiting user design review. No implementation changes.

## Outcome and agreed scope

A session working in a Git repository or ordinary directory can create a managed
SSH key, or import a private key it already generated from a local file. AgentPier
stores the key for that project. The session receives public metadata, installs
the public key using an existing access or provider workflow, saves the target
host, and tests the new connection. Later sessions of the same project can use it.

The owner can download generated and imported private keys from the web UI.
The session MCP never accepts or returns private-key contents. SSH discovery is
explained at session start, alongside the existing Memory and AgentBus hints.

Agreed with the user:

- Project accesses are inherited by existing and future sessions, including Git worktrees.
- Ordinary directories are projects too; shell `cd` does not change a session's project.
- Existing per-session accesses do not automatically become project accesses.
- Sessions can create, import, list, register and test; editing, rotation and deletion remain UI operations.
- Import takes a local file path, keeps the source unchanged, and reuses the project's existing matching public identity.
- Generation and import retain today's unencrypted-key support. Generation uses Ed25519.
- Bootstrap uses existing SSH access or a provider API. Password bootstrap is outside v1.

## Existing implementation and constraints

`SshKeyStore` and `SshAccessStore` maintain global reusable keys and hosts.
`SshSessions` grants individual hosts to live sessions. `ssh-mcp.js` currently
constructs stores in each MCP process; its tools only list hosts and execute commands.
This does not safely support concurrent catalog writers without an architectural change.

`projectScope()` identifies Git projects using the canonical common Git directory
and its filesystem identity; worktrees share it. Non-Git projects use the selected
directory's canonical path and filesystem identity. Separate clones are distinct.
Reuse this resolver, without requiring the Memory feature to be enabled.

The interactive SSH integration covers Codex, Claude and OpenCode. Login sessions
and headless pipeline sessions remain outside this feature. Shell sessions can
use the existing manual SSH helper and project grants, but have no MCP or startup
model hint. “All project sessions” means these supported interactive sessions.

The existing runtime executes as one OS user. Project checks constrain AgentPier
APIs; they are not an OS sandbox against a CLI with arbitrary local shell access.
In particular, UI-only export does not make owner-readable files inaccessible to
other processes of that owner.

## Architecture alternatives and decision

1. Let every MCP process write the existing JSON files: smallest superficial change,
   but unsafe read/modify/write races and no atomic host/key/idempotency publication.
2. Add shared cross-process locks around every catalog operation: possible, but
   complicates crash recovery and leaves mutation policy duplicated across callers.
3. **Recommended: one SSH management service owned by the application server.**
   UI and MCP delegate mutations to it. It validates scope, serializes commits and
   publishes one atomic catalog. Existing command execution remains in its current
   bounded helper/transport rather than being moved into a new remote job system.

Use option 3. Add a private local IPC endpoint, independent of AgentBus enablement,
with the session's existing generation capability. No new externally reachable
HTTP machine API. Server restart reconnects IPC; it does not broaden or erase grants.
Only one service may own a data directory. A live endpoint must never be unlinked
to start a second writer. Unexpected disconnect returns a retryable error.

The IPC socket and parent directory are owner-only. Authenticate each call using
the current persisted session capability, not merely knowledge of the socket path.
Bound request frames, connection count and operation duration; reject unknown
methods/fields. Management frames are at most 64 KiB, responses at most 512 KiB,
with at most 32 outstanding management calls per service and one key preparation
per session; excess work fails with a retryable busy error. Non-execution calls
have a 30-second deadline; subprocesses retain their shorter existing deadlines.
Private key bytes do not traverse this channel. The server-side
import operation reads the requested source file. A request cancelled before commit
may fail; one committed before disconnect is recoverable through its request ID.

The management service and HTTP routes share exactly the same validation and
mutation implementation. MCP project identity is resolved server-side; no tool
accepts arbitrary `projectId`, session ID, key storage path, or command invocation.

## Project identity and access rules

At launch bind SSH context to the validated project identity and launch directory,
separately from optional Memory capability state. Recheck the launch directory's
identity before project operations. Never use the model's shell cwd as authority.
Persist the launch directory's canonical path, device and inode separately from
the project ID and compare all three on each authorization. Replacing a linked
worktree at the same path must invalidate its old session even if its Git common
directory, and therefore shared project ID, remain unchanged.
Worktrees resolve through the same Git common directory. Different ordinary
directories, including nested directories selected as independent launch roots,
are distinct projects.

Missing/replaced/moved directories or a directory becoming a Git repository may
change identity. Fail project operations with `SSH_PROJECT_CHANGED` or
`SSH_PROJECT_UNAVAILABLE`; do not silently transfer keys or expose another project's
records. UI retains the old records and can explicitly reassign a project and its
owned resources to a validated target project. A session must reload to bind to
the target identity. This operation is owner-only, all-or-nothing, and explains
that grants for the old project are removed and grants for the target are added.
Preflight the full reassignment under the commit queue. If the target already owns
any matching canonical public key or matching endpoint/user tuple, reject the entire
move with a collision report containing public resource IDs only. Preserve both
projects' resources and all grants; no implicit deduplication, overwrite or ID
remapping during a move. Hostname comparison normalizes DNS case and literal IP
notation, without DNS lookup or alias merging. Key ownership cannot be moved alone
while a host still references it from another project. The UI validates the complete
affected set and commits it atomically, or leaves everything unchanged.

Each new key and host has one immutable project owner from the MCP's perspective.
Global legacy resources remain global. A project host must reference a key owned
by that same project. Explicit session grants allow use of a global or foreign
project host, but do not confer permission to list its private key metadata, change
its ownership, or use its key to register additional hosts.

Effective host access is the union of explicit session grants and current project
hosts. Resolve this union at every list, test, execution and periodic revocation
check; do not copy project IDs into static per-session grants. New hosts become
available on the next call. Duplicates appear once, with assignment provenance.
Deleting a host or changing project ownership revokes inherited access on the next
check; explicit grants remain a distinct, visible source of access unless the host
itself is deleted. Session termination clears ephemeral grants, not project data.

UI marks inherited accesses as “Project” and cannot misleadingly deselect them in
the per-session picker. Their management action leads to project access settings.
Users can still remove explicit grants. No new per-session deny override in v1.

## MCP contract

Names below are the proposed stable tool names. The provider supplies its normal
namespace prefix. Every tool rejects unknown fields, revalidates the live capability
and exposes only bounded public metadata and sanitized errors.

| Tool                 | Input                                                                              | Result / behavior                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ssh_list_keys`      | optional `page`                                                                    | Keys owned by this project; ID, name, public key, fingerprint, creation time.                              |
| `ssh_generate_key`   | `name`, `requestId`                                                                | Generate Ed25519 key in managed storage; return public metadata.                                           |
| `ssh_import_key`     | `name`, `sourcePath`, `requestId`                                                  | Read and validate local private-key file; copy into managed storage; return public metadata and `reused`.  |
| `ssh_get_public_key` | `keyId`                                                                            | Project-owned public key and fingerprint, never file path or private bytes.                                |
| `ssh_scan_host`      | `host`, optional `port`                                                            | Observed host keys/fingerprints explicitly marked unverified; does not save or grant.                      |
| `ssh_register_host`  | `name`, `host`, `port`, `username`, `keyId`, `hostKey`, `trustSource`, `requestId` | Store project host with an explicitly supplied pinned host key. No connection is made.                     |
| `ssh_test_host`      | `accessId`                                                                         | On an effective host, run the existing bounded `true` connection test; return success or classified error. |
| `ssh_list_hosts`     | existing empty input                                                               | Existing effective-host fields, plus project/explicit assignment provenance. Preserve existing fields.     |
| `ssh_execute`        | existing schema                                                                    | Execute only against an effective host; existing limits and revocation checks remain.                      |

`trustSource` identifies an existing assigned pinned access (`accessId`), a provider
console/API, or user-supplied verification. An existing access must match host and
port and its pin must match exactly, checked by the server. For provider/user
verification, record only the source category, not arbitrary narrative or secrets.
These categories are provenance declarations, not cryptographic proof. A raw scan
alone is not a trust source. Tool descriptions and the hook tell the agent to stop
and ask for a trusted fingerprint when no independent source is available.

Only project-owned keys may be used by `ssh_register_host`. Global/private-key IDs
are not a shortcut to acquire access. Registering the same project endpoint, user,
key and pin reuses its host; conflicting saved pin/key requires a UI change rather
than silently replacing a host. Host names are labels, not resource identities.

Public lists are paginated (20 records); retain existing `ssh_list_hosts` response
compatibility and its bounded result policy, with a clear limit error if the
effective list exceeds the transport budget. Errors distinguish invalid arguments,
revoked access, wrong project, unsupported encrypted key, changed identity, conflict,
missing source and service unavailability without echoing source bytes or key output.

## File import

`sourcePath` supports an absolute local path or `~/...`, expanding home from the
server-controlled session account environment, never from model-supplied variables.
Relative paths, `~otheruser`, URLs, globbing and shell expansion are rejected.
The source need not be inside the project: importing an existing `~/.ssh/...` key
is an explicit requirement. No directory scan or bulk import occurs.

Resolve the source, open a non-symlink final file descriptor, verify it is a regular
file owned by the server OS user, and read at most 64 KiB with a bounded operation.
Reject special files, directories and final-component symlinks. Validate ancestry
and the open file identity against the resolved path; reject a replacement during
validation. Exclude AgentPier's managed data directory as an import source, including
canonical aliases and hard links to managed identities, so import cannot adopt a
foreign managed key by guessing its path. This is defense in depth, not an OS sandbox.

Copy the bounded bytes into a private staging file; derive the public identity using
the existing OpenSSH validation. Reject encrypted/malformed/oversized keys without
publishing a record. Preserve source bytes and permissions; never delete, chmod or
overwrite the source. Final managed files use owner-only directories (0700) and
private/public key files (0600), following existing storage conventions.

Deduplicate by canonical public identity within the same project. Reuse does not
rename the stored key, change its ownership or touch existing hosts. An identical
key in a different project/global catalog creates a separate owned managed copy;
the operation does not disclose foreign records. Private bytes, source paths and
OpenSSH diagnostic output are not returned or written to audit events.

## Persistence, concurrency and retries

Introduce a versioned private SSH catalog containing keys, hosts and mutation
receipts in one atomic JSON snapshot. Keep identity file locations and legacy host
IDs stable. All metadata writes (including existing UI CRUD and migration) go through
the single service queue and the application mutation/snapshot barrier.

Prepare slow key validation/generation in isolated staging, then reauthorize and
revalidate references inside the commit queue. Rename staged identities into their
final private directory before atomically replacing the catalog. Readers see the
old or new complete snapshot, never a half-published host/key relationship.
Failure before catalog commit leaves no visible resource. Recovery removes only
proven unreferenced service-owned staging/final artifacts after no writer is active;
never user source files or referenced identities. Delete publishes removal before
cleaning up files. Referenced keys cannot be deleted. Export uses an already-open
validated descriptor so a concurrent deletion cannot redirect the download.

Every SSH connection/test uses one immutable host revision (endpoint, username,
key ID and pin). Materialize an execution-specific pinned known-hosts file; do not
rewrite a shared `known_hosts` file before publishing a host update. Execution
resolution, the manual helper and periodic checks must use the new catalog and
effective grant resolver. Revalidate the revision before spawn and during existing
MCP revocation checks; changing a host must not silently redirect an in-flight
operation. Cleanup owns only the invocation's temporary files. The manual interactive
helper retains its documented limitation that already-started connections may continue.

For create/import/register, a caller-generated `requestId` is stored with project,
operation, canonical input and resulting resource in the same catalog commit.
Identical retry resolves the original committed resource under the replay rules
below; changed input conflicts. Import retry
after successful commit does not reread a changed/missing source. Distinct requests
importing the same public key converge to one project key under the commit queue.
Deleted-resource receipts remain tombstones and never resurrect data. No blind
mutation retry by the transport; the hook explains how to reuse a request ID after
an uncertain outcome. Receipts are retained with the catalog and are not time-expired
in v1. Receipt replay still requires a valid current project capability and current
resource ownership. Store references, not a cached public response: return current
metadata for a still-owned unchanged identity; return a conflict if the host's
connection revision changed. Reassignment invalidates old-project receipts to
tombstones and never transfers their replay authority to the target project.
Deletion/reassignment updates every receipt referencing the resource, including
receipts from distinct import requests that deduplicated to it. Such a replay returns
the terminal `SSH_REQUEST_RESOURCE_GONE` outcome without rereading the import source
or creating anything. Tombstones stay under the original project/operation/request
ID even when ownership moves.
Use a 16 MiB serialized catalog limit for new growth (including receipts); on
exhaustion reject creation before commit rather than evicting receipts. Allow
deletion, revocation and size-reducing updates even at the limit. Legacy migration
must preserve oversized input and report that new growth is blocked.

Service startup performs an idempotent one-way migration from existing keys/hosts
JSON: preserve global ownership, IDs, public metadata, identity files and explicit
session grants; write and validate the unified catalog before selecting it as the
authoritative store. Legacy JSON is no longer read as authoritative or mutated.
Mixed old/new writers are unsupported: deployment must stop the old service first.
On first catalog-format migration, invalidate all persisted SSH capability files
before publication; old MCP clients fail their existing per-call/periodic checks.
Preserve explicit grants and mark sessions as reload-required. After catalog
publication, archive legacy catalogs outside their former active filenames so old
helpers cannot resolve stale hosts from them. A durable migration phase marker
makes interruption at either boundary recoverable before serving SSH requests.
Do not serve mutations or issue new capabilities until cutover is complete.
Ordinary later server restarts do not repeat this revocation. Do not rewrite user
`~/.ssh/config`. Document the minimum version and unsupported downgrade.

SSH data remains excluded from AgentPier backup/restore as today, including the new
catalog and receipts. UI download supports separate owner backup. Changes must not
accidentally start including SSH secrets or project grants in existing archives.

## Bootstrap and remote installation

Example: session starts in a project, generates/imports a key, retrieves its public
key, and uses an already granted host or provider API to install that public key for
the intended remote user. It verifies the target host fingerprint through that
trusted channel, registers the host and calls `ssh_test_host` before relying on it.

No dedicated `authorized_keys` installer is added in v1. Existing `ssh_execute` or
provider tools perform installation under the user's task authorization. The agent
must preserve existing authorized keys, avoid duplicate additions on retry, and
install for the intended remote user rather than assuming the bootstrap account.
The startup hint points to this sequence; tool documentation explains partial failure.

Key creation, remote installation, registration and testing are separate steps.
Remote success cannot be rolled back atomically with local storage. A failed test
or lost response does not automatically remove local or remote keys. Return the
precise failed step; retry inspection before remote mutation. If no bootstrap access
exists, provide the public key and setup guidance rather than pretending setup succeeded.

## UI and private-key download

Extend Settings > Server accesses with project ownership badges/filter and project
selection when creating/importing keys or hosts. Existing global entries remain
available and keep their explicit session assignment behavior. Changing a project's
owned resources, including reassignment after identity change, is an owner UI action.
Host/key editing must enforce same-project references and prevent partial moves.

Add “Download private key” to generated and imported key cards. Clicking initiates
an explicit authenticated POST/fetch download, not a private value in ordinary JSON
or a GET link. Use the existing owner login and Host/Origin policy; machine MCP tokens
cannot call it. Return attachment bytes with safe generated filename, `no-store`,
`nosniff` and restrictive content type. Blob URLs are revoked after download and
private contents are never rendered, copied to app state persistence or telemetry.

Do not require a new password prompt or a separate approval workflow. UI text states
that the downloaded file contains the unencrypted private key. Use a specific audit
event (`ssh.key.exported`) with resource ID and actor only; exclude bytes, source
paths, request bodies and raw subprocess errors. Generation/import/host registration
also record actor, project and resource IDs through the audit service.

All new UI text and errors need matching German/English catalogs. Exercise the
download and project ownership controls on desktop and mobile, including WebKit.

## Session discovery and lifecycle

Add a concise SSH reminder when the integration is available, including zero-host
projects: discover project keys/hosts; generate or import by path; obtain public key;
bootstrap through existing authorized access; verify host identity; register/test;
reuse request IDs; use only public metadata in chat. Mention private export is in UI.
Do not inject private material, commands, host lists or model-generated text into hooks.

Codex/Claude use their existing SessionStart composition pattern. OpenCode uses the
existing idempotent system-context plugin pattern. Preserve user hooks and Memory
and AgentBus configuration; do not create a second AgentBus reminder. Reuse the
existing AgentBus introductory content and test it together with SSH and Memory.
No periodic inbox polling or automatic SSH operations are introduced.

Hints describe tools; they do not grant access. Login/headless/shell contexts do not
receive model hints. Existing CLI processes need Reload & resume to obtain new tool
schemas and hints. Once updated, project grant changes apply without another reload.
Web service restarts must preserve valid session/project bindings and reconnect the
management client; CLI reload rotates generation credentials as today.

## Acceptance and adversarial tests

1. Git main checkout/worktree share keys and hosts; unrelated clones and ordinary
   directory projects do not. `cd` cannot switch ownership. Directory replacement,
   removal and `git init` fail closed until explicit UI reassignment/reload.
   Replacing a linked worktree against the same common Git directory still revokes
   its old launch binding. Moving into a populated target with key/host collisions
   fails atomically without changing either project's resources or grants.
2. Existing and newly started supported sessions inherit hosts immediately; explicit
   bootstrap grants do not turn into ownership. UI communicates both grant sources.
3. Two sessions create concurrently, import identical keys, and race UI deletion or
   rotation without lost records, foreign references or resurrection. Reauthorize
   after slow validation; revocation while queued cannot commit a mutation.
4. Kill the service before/after identity publication and catalog commit. Reconnect
   and retry returns one resource or a clear pre-commit failure, never duplicate keys.
   Replay after deletion/reassignment, including multiple deduplicated import
   receipts, returns a terminal outcome without private reads or recreation.
5. Foreign project/key/host IDs are denied. A global/foreign bootstrap access can
   execute but cannot be adopted or edited. Old capability generations fail.
6. Import outside project from `~/.ssh`, source preserved; duplicate reuse; missing,
   encrypted, malformed, oversized, symlink, special file, replaced path and managed
   identity/hardlink inputs rejected without secret-bearing output or hanging.
7. Host pin mismatch is fatal. Scan cannot imply verified trust. Wrong bootstrap user,
   missing bootstrap and failed remote authentication do not report a successful setup.
8. UI-only export works for generated/imported keys. Logged-out, cross-origin, machine
   token and invalid-ID requests fail. No private material in normal API/MCP results,
   hooks, audit, logs or errors; download filenames cannot inject headers or paths.
9. Memory + AgentBus + SSH + user hooks survive composition, once per relevant start
   context, on Codex/Claude/OpenCode. Zero-host hints work and excluded sessions remain
   excluded. Reload and service restart preserve the intended lifecycle.
10. Legacy migration preserves IDs/explicit grants without auto-sharing; interrupted
    migration is recoverable. Existing backups continue excluding all SSH artifacts.
    Run an old MCP process across cutover: subsequent calls fail, an active old MCP
    command is revoked through its existing checks, and old helpers cannot resolve
    archived catalogs. A later normal service restart retains compatible credentials.
11. Integration tests use isolated catalogs/fake transports; native smoke tests use
    disposable owned keys/hosts only. Never import actual personal keys or mutate a
    user's real authorized_keys for tests. Run catalog parity, focused backend and
    browser tests, full `npm run check`, and Linux/macOS/Chromium/WebKit CI.

## Non-goals and follow-up

No private-key export or byte import through MCP, encrypted-key/passphrase support,
password bootstrap, dedicated remote installer, arbitrary project switching by a
session, MCP delete/edit/rotation, headless pipeline expansion, automatic key scanning,
cloud-provider integration, new backup format, or claim of OS-level agent isolation.

## Adversarial review record

An independent read-only reviewer checked the design against the existing SSH
stores, capability checks, project resolver and session lifecycle. Review focused
on conflicting timelines, not just the happy path. Findings were incorporated and
the revised spec was reviewed again on 2026-09-17.

| Finding                                                                                | Resolution                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Atomic metadata alone does not make mutable host-pin files safe.                       | Immutable per-execution host revision and known-hosts snapshot; revision rechecks.                  |
| Old MCP clients could continue using legacy catalogs after upgrade.                    | One-time credential revocation, archived legacy active paths, recoverable cutover, explicit reload. |
| Lost-response replay could disclose or recreate a resource after a UI move.            | Current ownership checks and permanent original-project tombstones for all related receipts.        |
| Reassignment into a populated project could violate deduplication and host uniqueness. | Preflight collisions and reject the entire move; no implicit merge or ID remapping.                 |
| Git common-directory identity alone misses replacement of a worktree at the same path. | Separate canonical launch directory/device/inode binding in addition to project identity.           |

The second review found no remaining material contradiction or architectural blocker.
Its final wording correction was applied: replay resolves a committed resource under
current authorization, rather than promising a stale cached response. These are
design-review results, not evidence that the future implementation is secure or tested.

## Next step

This is a temporary working spec. After user review, create an implementation plan.
Before opening the implementation PR, move lasting behavior/operations guidance to
`docs/ssh-access.md` and `docs/architecture.md`, and remove completed temporary specs
and plans as required by repository policy.
