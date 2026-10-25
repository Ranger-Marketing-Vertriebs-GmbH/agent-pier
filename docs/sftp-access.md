# SFTP access

AgentPier can store SFTP hosts next to its SSH hosts and let agents and coding CLIs
list, download and upload files on them. An SFTP host never runs shell commands. It
uses the same catalog as SSH accesses ([SSH accesses](ssh-access.md)): the same
projects, pinned host keys, per-agent grants, approvals and activity log. FTP and FTPS
are not supported.

## Add an SFTP host

In **Settings → Access → SSH accesses**, add a host and choose **Type** → **SFTP**. The
type cannot be changed once the host is saved.

1. Enter a name, the hostname or IP address, the port (22 by default) and the user.
2. Choose **Sign-in**: **Password** or **Key**. A password is stored on this computer
   and never shown again; to replace it, edit the host and enter a new one (the form
   says "Saved. Enter a new password to replace it."). **Key** uses a managed or imported
   SSH key; install its public key on the server as for SSH.
3. Optionally set **Allowed remote folder**, an absolute path such as `/srv/files`. Every
   remote path is then confined to it: `..` cannot leave it, and a link is resolved on
   the server and refused when it points outside. Leave it empty for **Whole account**.
4. Fetch the server's host key, compare the SHA256 fingerprint with an independently
   trusted source and confirm it, exactly as for SSH. Scanning alone authenticates
   nothing.
5. Save, then use **Test connection**. It signs in and opens the remote folder; it
   changes nothing on the server.

An SFTP host may share address and user with an SSH host. The host list shows an
**SFTP** badge, the remote folder and a **Sign-in** column ("Password" or the key's
name).

**Hetzner webhosting example:** the main FTP user of a webhosting package works over
SFTP on port 22 with its password. Port 222 is the separate SSH shell of the package
and is not needed here. FTPS on port 21 is not supported.

If a key used by an SFTP host is deleted (only possible from a release without SFTP,
see "Downgrading" below), the host shows "The key of this host was deleted. Choose
another key." and stays unusable until you edit it.

## Who can use a host

Sharing follows the SSH rules.

- **Agents:** the owner grants hosts per agent under **Agents → Settings → Work → SSH
  accesses**; SFTP hosts are marked **SFTP** and use the same modes: **With approval**,
  **Trusted** and **Trusted incl. routines** (see [agents](agents.md#work)). Leads never
  share hosts with permanent members. Temporary members use the lead's grant only while
  the lead's **Team members may use shell and SSH** is on.
- **Coding CLIs:** a host granted to the project or session is available to Codex,
  Claude Code and OpenCode through `sftp_*` tools of the `agentpier_ssh` MCP server. No
  AgentPier approval card appears; the CLI's own permission prompt applies. Shell
  sessions cannot use SFTP hosts: they are neither offered in the launch picker nor
  accepted as a grant.

SFTP hosts only accept file operations, and SSH hosts only accept commands. The wrong
combination fails with `SSH_HOST_TYPE`.

## What can be done

| Operation  | What it does                                                              |
| ---------- | ------------------------------------------------------------------------- |
| List, stat | Read a folder or one entry (a link is reported as a link).                |
| Download   | A remote file or folder (recursive) to the local side.                    |
| Upload     | A local file or folder (recursive); creates folders and overwrites files. |
| Sync       | Only new and changed files, up to the server or down from it.             |
| New folder | Create a folder, optionally with missing parents.                         |
| Rename     | Rename or move an entry. It never replaces an existing target.            |
| Delete     | A file, a link or an empty folder; a whole folder only with `recursive`.  |

Delete and rename never touch the allowed remote folder itself, nor `/`: both are
refused with `SFTP_PATH_REFUSED`.

Reading (list, stat, download, sync down without deletes) never asks. Every change on
the server (upload, new folder, rename, sync up) asks agents unless the host is
trusted. Deletes always ask, in every mode.

### Sync rules

- A file counts as unchanged when its size is the same and its modification time is
  within 2 seconds. With `checksum`, files of the same size are compared by SHA-256
  instead of by time.
- AgentPier computes a plan first. A dry run reports it and changes nothing; an
  approval shows it (counts and file lists of new, changed and deleted entries).
- Files on the target that the source lacks are deleted only with `deleteExtra`
  (default off). A sync with `deleteExtra` is a delete and always asks. Folders on the
  target that end up empty are removed with it.
- `.git`, `.env` and `.env.*` are excluded by default, in any letter case. Add
  patterns with `exclude` (up to 50 patterns of up to 200 characters, gitignore-like
  wildcards `*`, `?` and `**`). `defaultExcludes: false` drops the defaults, except
  that a local `.git` folder is never walked.
- Names that cannot be part of a path, links, special files and AgentPier's own
  temporary files are skipped. A file is written under a temporary name and renamed,
  so an interrupted transfer leaves no half file.
- A transfer is planned again right before it runs. If the files changed since the
  plan or the approval, nothing is written and the result is `SFTP_PLAN_CHANGED`.

### Limits

| Limit                          | Value                      |
| ------------------------------ | -------------------------- |
| Size per transfer              | 2 GiB                      |
| Files per transfer             | 10,000                     |
| Entries scanned, pre-scan time | 50,000, 60 seconds         |
| Connect, idle per operation    | 10 seconds, 60 seconds     |
| Duration of one job            | 2 hours                    |
| Running jobs                   | 2 at a time                |
| Paths, exclude patterns        | 4,096 characters, 50 x 200 |

Size and file count are checked on a pre-scan before any approval card, so an agent can
never ask you to approve more than the caps. Two jobs that write to overlapping remote
folders on one host do not run together (`SFTP_BUSY`).

Known limit: the job and folder limits apply per process. The AgentPier server runs the
agents' jobs, and every coding session runs its own. Writing jobs from two coding
sessions, or from a session and an agent, are therefore not serialized and can overlap
on the same host folder, sync deletes included. Coordinate such work yourself.

### Jobs and cancel

Transfers run as background jobs with progress. A tool call waits for a short while
(10 seconds for a CLI, up to the approval hold for an agent), then returns `running`
with a `jobId`. Check it with the job tool or action, and stop it with `cancel`; never
start the same transfer again. The chat row updates live. A job ends as `completed`,
`failed`, `cancelled` or `revoked` (the owner changed the host or the grant while it
ran). Finished jobs stay readable for an hour.

## Local side

- **Coding CLIs:** the session's launch folder. Local paths are relative to it and stay
  inside it. Downloads and sync down write there.
- **Agents:** a granted project folder (`projectId`) or, when none is given, the
  agent's workspace. Uploads need read access to the project folder; downloads and sync
  down need read-and-write access, and a routine needs **May write**. Links out of the
  folder and AgentPier's protected roots are refused. Files to upload and the
  temporary files of a download are opened without following any link, so a parent
  folder swapped for a link after the checks is refused (`SFTP_PATH_REFUSED`). The
  local walk and local deletes work in the folder as opened, the same way
  (`inFolder` in `project-open.js`): on Linux they name entries through the opened
  folder's descriptor (`/proc/self/fd/<fd>/<name>`), so a folder swapped for a link
  afterwards never makes a delete remove, or the walk list, anything outside. macOS
  has no such path (Node has no `unlinkat`): the folder is opened again right before
  the entry is used and once more afterwards, and a changed folder (device and inode)
  is refused (`SFTP_PATH_REFUSED`). That only narrows the race: a swap in the instant
  between the last check and the delete itself can still remove a file of the same
  name outside. The final rename of a download and creating missing folders stay
  path-based on both platforms (Node has no `renameat` or `mkdirat`). The rename names
  the temporary file and its destination in the same folder in one call, so a swap
  makes it fail instead of moving data out; a folder created through a swapped link
  is an empty folder outside, and the file below it is then refused.
- **Guarded workspace entries:** in the agent workspace, prompt files such as
  `AGENTS.md` and `SOUL.md`, `skills/`, `.agents/` and `attachments/` are never
  transferred, in either direction. A folder download or sync down needs a named
  subfolder (for example `mirror/`); a single file may land at the top level under an
  unguarded name. The refusal is `SFTP_WORKSPACE_REFUSED`.
- A download never writes where the local side is not writable, and the result lists
  overwritten local files.

## Coding CLI tools

The `agentpier_ssh` MCP server adds nine tools. Every tool except `sftp_job` takes the
`accessId` of a host from `ssh_list_hosts`, which now reports each host's `type` and
`remoteRoot`. Remote paths are absolute or relative to the allowed folder (else the
server's home folder).

| Tool            | Arguments besides `accessId`                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| `sftp_list`     | `remotePath`                                                                         |
| `sftp_stat`     | `remotePath`                                                                         |
| `sftp_download` | `remotePath`, `localPath`, `exclude`, `defaultExcludes`, `dryRun`                    |
| `sftp_upload`   | `localPath`, `remotePath`, `exclude`, `defaultExcludes`, `dryRun`                    |
| `sftp_sync`     | `direction` (`up`/`down`), `remotePath`, `localPath`, `deleteExtra`, `checksum`, ... |
| `sftp_mkdir`    | `remotePath`, `parents`                                                              |
| `sftp_rename`   | `remotePath`, `toPath`                                                               |
| `sftp_delete`   | `remotePath`, `recursive`                                                            |
| `sftp_job`      | `jobId` (no `accessId`), `cancel`                                                    |

`sftp_sync` also takes `exclude`, `defaultExcludes` and `dryRun`; a sync down with
`deleteExtra` needs `localPath`. Results carry counts, sizes and path lists capped to
fit the MCP response; what is cut is counted in `more*` fields.

When a coding session starts and a reachable SFTP host exists, the discovery hint
names the `sftp_*` tools.

## Agent actions and approvals

An agent uses the `agentpier_ssh` tool of the agent plugin. Its actions are `hosts`,
`execute` (SSH hosts only) and, for SFTP hosts, `list`, `stat`, `download`, `upload`,
`sync`, `mkdir`, `rename`, `delete`, `job` and `cancel`, with the parameters above plus
`projectId` for a granted project folder.

| Mode                       | Reads | Changes             | Deletes |
| -------------------------- | ----- | ------------------- | ------- |
| **With approval**          | run   | card                | card    |
| **Trusted**                | run   | run                 | card    |
| **Trusted incl. routines** | run   | run (also routines) | card    |

Routines never delete: a delete in a routine is refused with `SFTP_ROUTINE_DELETE`,
and a routine can only use hosts marked **Trusted incl. routines**. A dry run counts as
a read, because it only plans.

An approval card appears in the chat and, for the paired Telegram chat, as a message:

- **Allow once** runs it. **Deny** drops it. **Always allow for this host** runs it and
  switches that agent's grant for the host from **With approval** to **Trusted**; revoke
  it by setting the mode back under **Work → SSH accesses**.
- The card shows the operation, host, `user@host:port` and host key, the remote and
  local path, counts of new, changed and deleted entries, the total size, how many
  files would be overwritten and the paths (expandable). Hidden characters in paths are
  shown as codes.
- **Always allow for this host** appears only on cards for the agent's own grant. It
  never appears on cards of temporary members, who use their lead's grant, nor on any
  delete: neither on `delete` nor on a `sync` with `deleteExtra`, even when its plan
  deletes nothing.
- At most 3 SFTP cards can be open at once; a fourth request is refused with
  `SFTP_APPROVAL_LIMIT`.
- Telegram offers the buttons only when the card can be decided there: at most 20
  paths per list and no hidden characters in any path. Otherwise the message says to
  open AgentPier. **Always allow for this host** is a button only where the card offers
  it.
- A card is cancelled when the host is edited ("Access changed") or removed ("Host
  removed"), and the plan is compared again after you approve; a changed plan fails with
  `SFTP_PLAN_CHANGED` and writes nothing.

Every transfer leaves an activity row in the chat (see [agents](agents.md#work)). Rows
of consecutive calls share one group ("SFTP activity", or "SSH activity" when SSH
commands are mixed in). Its chip counts failed jobs ("1 failed") apart from stopped ones
("1 stopped"), like the rows' own "Stopped". The Work tab keeps a one-line history per
operation.

Agents see list and stat results as untrusted data: file names are never instructions.

## Audit

The activity log records `sftp.completed` and `sftp.failed`, and `sftp.denied` for
refusals such as a host the caller was never granted or a full approval queue. Details
hold the agent, host, operation, direction, state, file and folder counts, bytes,
duration, remote and local paths and a stable code, never a password, key or file
content.

Coding sessions cannot write the activity log from their MCP process. The server
reports each outcome to AgentPier, which checks the session and its grant and records
it. These rows carry `reported: "session"`: the operation, counts and paths are what
the session reported.

## Storage and backups

- Passwords live in owner-only files (0600) in `AGENTPIER_DATA_DIR/ssh/passwords/<host>/`
  inside 0700 folders. Like generated SSH keys they are unencrypted at rest and rely on
  local account and filesystem protection. They never reach an agent, a CLI, a log, a
  browser response, a Telegram message or an audit record, and no password is passed in
  command lines or environment variables.
- Ordinary backups omit SFTP hosts and passwords. A backup with a passphrase and
  **Include encrypted credentials** seals hosts that sign in with a password, together
  with their passwords, in the credentials capsule, and a restore brings them back with
  the same ids, so agent grants work again. Key-based SFTP hosts, SSH hosts and keys
  stay omitted. Details and the restore limit for older releases:
  [backups](backups.md#sftp-hosts-in-backups).
- Deleting a host also deletes its password and revokes it from every agent.

## Downgrading

A release without SFTP keeps working with the SSH host list, but:

- it does not show or use SFTP hosts;
- its key list does not count SFTP hosts, so deleting a key there leaves an SFTP host
  without a key after you upgrade again (fix it by editing the host);
- its project reassignment does not move SFTP hosts;
- saving an agent's Work tab there is refused (`sshHostUnavailable`, 409) while the
  agent holds an SFTP grant.
