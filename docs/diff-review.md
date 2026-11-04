# Reviewing a session's changes

The **Changes** tab of a session shows what the session's agent has changed in the
working tree, as a diff you can read and comment on. It is owner-only and closed until
you open it; nothing is sent to the agent unless you press **Send to agent** and then
send the message in the chat yourself. Every session has the tab, shell sessions
included. The tab shows the number of changed files as a badge. A session whose folder
is not a Git repository, and a login session, shows a short note there instead and no
badge.

You can also open it from the search (⌘K or Ctrl+K): **Show changes** (German:
**Änderungen anzeigen**; also found as "Diff" and "Review changes") appears while a
single session is open.

## Workspaces and bases

A session can work in more than one checkout, so a **Workspace** picker lists:

- the session directory (its Git top-level folder), and
- the worktrees under the main repository's `.worktrees/` folder.

Pipeline worktrees (`.agentpier-worktrees/`) and any other worktree are not listed. The
badge counts only listed workspaces.

Each workspace is compared with a base, which the tab names above the diff:

| Workspace state                           | Base                                      | Label                                                |
| ----------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| On a branch other than the default branch | the merge base of `HEAD` and the default  | Since the branch point with `<default branch>`       |
| On the default branch or a detached HEAD  | the commit the session started on         | Since the session started                            |
| Same, in a worktree                       | `HEAD`                                    | Uncommitted changes only                             |
| Session started before AgentPier recorded | `HEAD` at the first time the tab was read | Since this session was first viewed after the update |

The default branch is `origin/HEAD`, else `main`, else `master`. A reloaded or
account-switched session keeps its recorded start commit. Uncommitted and untracked
files (not ignored) are included; at most 200 untracked files are listed, files over
256 KB or binary files add no line counts, and binaries show as "Binary file". A diff
is read up to 1 MB; beyond that the tab says the rest is not shown.

The tab updates by itself while it is visible: when an agent turn starts or ends, and
otherwise at most once a minute, so the badge can be up to a minute behind outside
agent turns.

## Comments

Click a line to write a comment (Markdown, at most 8192 bytes). A comment is:

- **open** until you resolve it (**Resolve**; **Reopen** brings it back),
- **Outdated** when its line no longer exists in the current diff; comments on files
  that are no longer changed are listed under "Comments on files that are no longer
  changed",
- **Sent in batch N** once it went into a batch (see below).

Comments belong to the session and stay across reloads.

## Send to agent

**Send to agent (n)** collects every open comment of the session across all
workspaces into one batch, with file paths relative to the session folder so the agent
can open them from its own directory. For the current workspace it uses the diff
already loaded; it reads the others first to find each comment's line again.

- A chat session gets the batch in its composer. A non-blank draft is kept and the
  batch is appended after a new line; a blank draft is replaced. You then send it.
- A draft plus batch over 32,000 characters is refused with a notice, never
  truncated; the draft and the comments stay as they were.
- A shell or terminal-only session, a session whose chat is still delivering a message,
  and a session without a chat composer get the batch on the clipboard instead.
- If the browser refuses the clipboard (iOS and Safari do after asynchronous work),
  a dialog shows the batch to copy by hand. The comments are marked as sent when the
  batch was appended or copied, not when it was only shown.

## Pipeline runs

A pipeline run has the same diff view in its run detail: **Review changes** opens the
run's whole diff against its base commit, and its comments go to the stage with the
next **Retry with feedback**, **Return for repair** or group member feedback instead of
**Send to agent**. Run paths are relative to the run's worktree, and the limit there is
32 KB (32,768 UTF-8 bytes) of typed text and comments together. See
[pipelines › reviewing a run's changes](pipelines.md#reviewing-a-runs-changes).
