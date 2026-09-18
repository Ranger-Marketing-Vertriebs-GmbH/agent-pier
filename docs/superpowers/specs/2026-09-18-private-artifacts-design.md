# Private session artifacts

Status: approved by the user on 2026-09-18; implementation is not started.

## Purpose and scope

AgentPier gives its supported coding CLIs one shared way to publish images and
interactive HTML results. Artifacts open in their own browser tab through the
owner's existing private AgentPier access. They are not public sharing links.

The first release supports HTML, CSS, browser JavaScript, images and accompanying
static files. It does not run Node, Python, development servers or build commands.
An agent must produce browser-ready files before publishing. Opening a published
artifact does not require its originating CLI or worktree to remain available.

## Confirmed behavior

- Each artifact belongs to a project and its originating AgentPier session.
- AgentPier stores an independent copy of explicitly selected output files.
- Updates replace the published content under the same stable URL. There is no
  user-visible version history.
- Stopping or completing a session retains its artifacts.
- Deleting a session deletes its unpinned artifacts. Pinned artifacts survive and
  remain discoverable in the project overview.
- The owner can delete any artifact individually, including a pinned artifact.
- Session and project lists show title, type, last update, size and pin state.
  Actions are Open, Pin/Unpin and Delete. Open uses a new browser tab.

## Existing integration points

`server/features/mcp/session-integration.js` injects a session MCP connection into
standalone Codex, Claude Code and OpenCode sessions with AgentPier tools enabled.
`session-capability.js` already verifies the originating session. Extend this
path and the shared tool service instead of introducing another CLI registration.

The shared tool service must receive trusted session identity from the transport;
it must not accept a caller-supplied session ID as proof of ownership. The initial
release exposes artifact publishing only on authenticated session connections.
External OAuth clients without session identity and pipeline sessions do not gain
publishing implicitly. Existing pipeline `run_artifact` tools remain separate.

`SessionManager.remove` is the authoritative session deletion boundary. Artifact
cleanup must run for every caller of that boundary, not only its HTTP route.
Reload and replacement preserve the original session and its artifacts.

## Proposed tool contract

`artifact_publish({ requestId, title, sourcePath, entrypoint?, artifactId? })`
publishes a single file or a directory. A directory requires an HTML entrypoint
relative to that directory. `artifactId` replaces an existing artifact belonging
to the current session; omitting it creates one. Return the artifact ID, URL,
title, media type, size and last-update time. Publishing does not open a browser
automatically.

`artifacts_list()` lists the current session's artifacts so an agent can retrieve
an ID for an update. Pinning and deletion are owner UI operations in the first
release. A surviving artifact from a deleted session remains readable and
manageable by the owner but cannot be adopted or overwritten by another session.

`requestId` makes retry after an uncertain response safe. Reusing it with the same
arguments returns the original receipt; reusing it with different arguments is a
conflict. Updates are serialized per artifact and deletion wins over in-flight
updates. A late publish cannot resurrect a deleted artifact or session.

## Storage and lifetime

Keep metadata and content in the private AgentPier data directory under
`artifacts/`, outside Git and worktrees. Metadata includes an opaque ID, project
ID, session ID, title, entrypoint, media type, byte size, created/updated times,
pin state and the current content generation.

Copy into a staging generation, validate the complete bundle, then atomically
switch the published metadata pointer. Readers see one complete generation.
Remove superseded generations after active reads finish. An interrupted update
leaves the prior publication intact. A failed first publication has no usable URL.

Record durable deletion intent before removing files. Session deletion records
cleanup intent for its unpinned artifacts before removing session metadata.
Pinned artifacts keep their project association and an optional historical
session label; absence of the session is expected.

A startup and periodic reconciliation pass retries deletion, removes abandoned
staging directories and superseded generations, and detects orphaned unpinned
artifacts whose sessions no longer exist. It must not sweep live staging writes.
Use the same mutation coordination as publication and deletion. A failed disk
delete never restores visibility; the deletion marker remains until cleanup works.

Unpinning an artifact whose session has already been deleted explicitly deletes
it after the UI explains the consequence. There is no age-based expiration.

Proposed initial limits: 50 MiB per publication, 500 files per bundle and 1 GiB
total managed artifact storage. Staging counts toward the budget. Reject a
publication before exhausting storage and keep the previous generation intact.
Pinned artifacts count toward the same budget. Show used storage so the owner can
choose what to delete; never evict artifacts silently to make space.

## File selection and private rendering

Resolve source paths against the session workspace and limit publication to that
workspace. Only explicitly selected output is copied; never infer that the whole
repository should be published. Reject symlinks, special files, traversal,
absolute bundle entry paths and duplicate normalized paths. Bound file count and
bytes while copying as well as during preflight to handle changing source files.
Do not return filesystem paths or credentials in metadata responses.

Serve a trusted artifact viewer in the new tab behind the existing owner access
boundary. Render HTML in a sandbox with scripts enabled and without same-origin
privileges. Apply response-level restrictions to direct content URLs too, so the
viewer cannot be bypassed to execute generated HTML in AgentPier's origin.
Generated code must not read owner cookies, application storage or authenticated
management APIs, navigate the parent or register service workers.

Static bundle resources must work inside that isolation on Chromium and WebKit.
Keep resources local to the bundle in the initial release; external network
requests, external script dependencies and server API calls are out of scope.
Resolve asset URLs to the selected immutable generation so an update cannot mix
old HTML with new dependencies. Use explicit MIME types and nosniff. SVG is active
content and receives the same isolation requirements as HTML.

The implementation must prove private access and isolation together with normal
HTML/CSS/JavaScript loading before the renderer design is considered complete.
A hard-to-guess URL by itself is not authorization.

## UI and errors

Add a compact artifact list to the session workspace and a project artifact view
that includes surviving pinned artifacts. Empty, publishing, unavailable, deleted
and cleanup-pending states must be understandable. Update lists after mutations.

Use stable translated error identifiers for missing input, invalid bundles, size
limits, insufficient space, access rejection, deleted sessions and conflicts.
Preserve the previous artifact when an update fails. Deleted links show an
unavailable page rather than falling back to the main application.

All product copy must have matching German and English catalogs and interpolation
arguments. Use reactive message exports. Verify the changed flows in English.

## Implementation sequence and acceptance criteria

1. Build the artifact storage service with isolated temporary-directory tests.
   Cover create, replacement, retry receipts, bounds, unsafe paths, concurrent
   updates/deletion, interrupted writes and recovery after filesystem errors.
2. Connect verified session context to the MCP tools. Test all three supported
   CLI launch configurations, disabled tools, invalid identity, cross-session
   access and external clients without a session context.
3. Add private viewer and content routes. Browser tests must render a multi-file
   interactive example and image, reject unauthorized reads, and prove generated
   code cannot access management APIs/storage or escape its sandbox, including
   when content URLs are opened directly. Test Chromium and WebKit.
4. Integrate durable session cleanup and pin lifecycle. Test stop versus delete,
   reload, pinned survival, unpin after session deletion, interrupted deletion and
   restart reconciliation without deleting active writes.
5. Add session/project management UI, storage usage and translated errors. Verify
   opening a new tab, updates under a stable URL, pinning, manual deletion and
   mobile layout. Run catalog parity tests and exercise English UI.
6. Run `npm run check` and the focused browser suite with disposable data and an
   isolated tmux server where needed. Keep source/test files under 600 lines.
   Document operation in `docs/`, remove completed temporary specs/plans before
   the implementation PR, include UI screenshots and follow protected-main CI
   and review rules.

Use macOS or Linux with Node.js 22.13+, Git and tmux. No additional runtime tool is
required by this design. If implementation introduces one, both installation and
existing-installation update scripts must provision it.

## Review boundary

The user approved the product behavior and requested a repository specification.
The proposed tool arguments, limits and rendering restrictions above make that
behavior concrete for review. No application implementation or deployment is
included in this planning change. The implementation plan is recorded in
`docs/superpowers/plans/2026-09-18-private-artifacts.md`.
