# Delete a project — design

Status: owner-approved description (2026-11-16), pending builder check.

## Intent

The owner wants to get rid of a project they no longer need: remove it from AgentPier **and** delete its folder from disk, permanently, with a clear warning first. Today nothing can remove a project; the ⋯ menu's "Remove" only takes it out of its group.

## Goals

- An owner-only action **"Delete project…"** in the project's ⋯ menu (list and detail) and in the `ProjectDetail.jsx` header.
- A confirmation dialog built from the existing dialog primitives (`docs/ui-guide.md`) that:
  - names the full folder path and states plainly that the folder and everything in it is deleted from disk permanently and cannot be undone;
  - requires typing the project name before the delete button enables;
  - shows a preflight report from the server (see below).
- After confirmation: the folder is deleted from disk permanently (no trash), and everything AgentPier keeps about the project is removed. The project disappears live from every list (`projects.changed`, plus `agentbus.changed` / `project-groups.changed` where they apply).
- An audit entry `project.deleted` (who, when, project id, path, `source: "owner"`).
- German and English copy (i18n parity, `npm run i18n:confirm`), ⌘K search entry ("Delete project", alias "Remove project"), docs updated.

## Preflight (server, shown in the dialog)

- **Running sessions** in the project (coding sessions whose cwd/project id belong to it, agent coding sessions, running pipeline runs and queued items). Owner decision: these **block** the delete. The dialog lists them and offers "Stop sessions" (using the existing stop paths); the delete button stays disabled until none are running.
- **Other processes using the folder** (owner request 2026-11-16): processes whose working directory or open files are inside the folder, e.g. preview/dev servers started from it, agent background commands, editors or shells (macOS and Linux; e.g. `lsof +D`-style detection or `/proc` on Linux, bounded in time). They also **block**; the dialog lists each (name, PID, what it is if AgentPier knows it) and offers to end them: AgentPier-owned ones through their own stop paths (previews, sessions, background commands), foreign ones with SIGTERM then SIGKILL after a grace period, each after the owner ticks it. Processes AgentPier itself needs (its server, the Gateway) are never offered; if one of those uses the folder, the delete is refused with an explanation.
- **Unsaved Git work**: uncommitted changes and commits not on any remote, for the project folder and for its worktrees (`.worktrees/`, `.agentpier-worktrees/`, and linked worktrees elsewhere that belong to the repo). Owner decision: **warn only**, prominently, listing what would be lost.
- **Nested projects**: other registered projects inside the folder. They are deleted with it; the dialog lists them and the delete removes their AgentPier data too.
- **Who has access**: agents with grants for the project (incl. agents of restricted users) and users who can see it. Informational.
- The preflight returns a token/fingerprint (path, device+inode, id); the delete must present it and the server re-checks it, so a stale dialog cannot delete a different folder.

## What gets removed (AgentPier data)

Mirror `ProjectRebind.remnants()`/`adopt()` (`server/application/project-rebind.js`), with "remove" instead of "move":
memory rows and entries (`memory.sqlite`: projects, entries, revisions, requests, tombstones, capabilities, rebinds/merges), session records for the project, AgentBus `agentbus/projects/<id>/`, pipeline runs, queue items, verification/risk/queue settings, ticket links/rules/sequences, SSH host/key access, secrets with that project id, artifacts, agent grants (`projectIds`, `sessionProjectIds`, `talkProjectIds`, `projectFiles`, pending approvals), `agent_created_projects`, Craft rebuild records, group assignment, cloned-repo entry in `repositories.json`. Audit history is kept.

## Safety constraints

- Owner only; restricted users never see the action or route.
- Refuse dangerous paths: filesystem root, the home directory and its direct parents, AgentPier's own data directory or install directory, the AgentPier repo itself while it runs, and any path that contains the data dir. Refuse if the path is a symlink to elsewhere (delete the registered real folder only after re-resolving it).
- Re-check device+inode right before `fs.rm` (pattern of `server/features/projects/project-folder.js:120-148`).
- Make the operation resumable like `agent-deletion.js`: mark the project "deleting", remove data, delete the folder, then drop the mark; a crash midway is finished at next start. A folder that fails to delete (permissions) leaves a clear error and the project in a "deletion failed" state the owner can retry.
- Projects that are only an AgentBus folder or only a cloned repo entry are deletable the same way.

## Non-goals

- No trash/undo, no macOS Trash.
- No deleting remote Git repositories.
- No bulk delete.
- No "remove from AgentPier but keep the folder" (could come later; not requested).

## Left to the builder

Route shape, module boundaries (likely `server/application/project-deletion.js` next to `project-rebind.js`), how preflight Git checks are run (reuse existing git helpers), dialog layout within the UI guide, test split (unit for the walk and path guards, integration for the route, a browser test for the dialog).

## Calls made after the builder check (author's calls, owner may override)

1. **Foreign processes:** only processes of the same OS user as AgentPier are listed and offered; other users' processes are listed as blockers that AgentPier cannot end. The owner's own editor/terminal/shell is offered like any other process. Never offered: AgentPier's server and its ancestors, the tmux server process itself (sessions are ended individually instead), the agents' Gateway, and PID 1. Detection: `lsof` (cwd + open files under the path) on macOS and Linux, `/proc/*/cwd` as Linux fallback, with a 10 s bound.
2. **Races:** from confirmation on, the project is in a persisted `deleting` state; every start path (sessions, pipeline runs and queue, previews, ticket worktrees, agent coding sessions, AgentBus registration) refuses that project. The server re-runs the blocker check after setting the state and aborts (clearing the state) if anything is still running. The preflight token covers path, device+inode and id; blockers are always re-checked server-side.
3. **Nested projects:** included in preflight like the main project: their sessions/processes block, their unsaved Git work warns, and their data is removed. Typing the main project's name confirms all of them; the dialog lists them by name. Linked Git worktrees outside the folder are **not** deleted: they are listed with a warning, and after the delete AgentPier runs nothing on them (their metadata in the deleted repo is gone; the owner removes them by hand).
4. **State:** `deleting`/`deletion failed` is stored on the project row (memory.sqlite) so it survives restarts. Such a project is hidden immediately from restricted users and agents (grants revoked first); the owner's list shows it greyed with "Deleting…" or "Deletion failed — Retry". Order: mark → revoke grants → stop nothing (blockers must be empty) → delete the folder → remove AgentPier data → drop the row. Deleting the folder before the data means a failure leaves a complete project the owner can retry; start-up recovery resumes a `deleting` project from where it stopped.
5. **Scope of removal:** local data only. Remote ticket systems, Git remotes and SSH hosts themselves are not touched. OpenClaw agent workspaces are not deleted; agents lose the grant, and files they copied stay theirs.
6. **Dangerous paths:** also refuse the home directory's direct children (e.g. `~/Projects`, `~/Documents`, `~/Desktop`), any mount point, and the checkout/install the running AgentPier server runs from.
7. **Preflight time:** each check is bounded (Git per worktree 10 s, process scan 10 s). A check that does not finish is shown as "could not be checked" and counts as a warning, not a blocker, except the process scan, whose timeout blocks (retry offered).
8. **Audit:** `project.deleted` records project id, path, nested project ids, ended processes/sessions, and whether unsaved Git work was reported; `source: "owner"`.

## Projects whose folder is already gone (owner request 2026-11-16)

- A project whose registered folder no longer exists (deleted or moved outside AgentPier) stays in the list today. The project list and detail mark it **"Folder missing"** (de: „Ordner fehlt“), computed on read and pushed on `projects.changed`; a missing volume (unmounted disk, network share) is shown as **"Drive not available"** instead and is not treated as deleted.
- Its delete action reads **"Remove from AgentPier…"**. The dialog says the folder is already gone and only AgentPier's data is removed; no name typing is needed, a plain confirm suffices. Preflight runs only the checks that still make sense: running sessions/agent coding sessions/runs for the project (block, with "Stop sessions"), nested registered projects under the missing path (removed too), access grants (informational). No process scan, no Git checks.
- The data removal is the same walk as a normal delete; the folder step is skipped. If the folder reappears between preflight and confirm (same path exists again), the server refuses and the dialog switches to the full delete flow.
- The project list gets a filter or a "Folder missing (n)" hint so several stale projects can be found; deleting them stays one by one (bulk delete remains a non-goal).
- Danger-path rules do not apply (nothing on disk is touched).
