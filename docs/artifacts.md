# Private artifacts

AgentPier-hosted Codex, Claude Code and OpenCode sessions with **AgentPier tools**
enabled can publish static results using `artifact_publish`. Open **Artifacts** in
the sidebar for the overview, or expand **Artifacts** in a session.
**Open** displays the result in a separate browser tab, behind the existing owner
login. URLs do not grant access by themselves.

## The Artifacts page

The page follows the [settings pattern](settings-pattern.md). The **All** and
**Pinned** tabs show their counts; the search field matches titles, session names
and project names, and the project filter keeps the `/artifacts/<projectId>`
address. Rows are grouped by date (Today, Yesterday, This week, Earlier) and show
the type, the source session and project, and a relative time (the exact time is in
the tooltip).

A row opens the detail: in the right pane on desktop (the newest artifact is shown
until one is chosen), as a subpage with a back arrow on phones. The selection is part
of the address together with the filters (`/artifacts[/<projectId>]?session=<id>&q=<term>&page=<n>&tab=pinned&artifact=<id>`),
so a reload or the viewer's **Back to AgentPier** returns to the same detail and list. The detail shows a
preview, **Open**, **Copy link** (the link only works when signed in), the source
session and project, the pin switch, technical details and **Delete artifact**,
which asks for confirmation. The preview loads the selected artifact only, once it
is on screen, in an inert iframe with `sandbox=""`: scripts never run there, so pages
that draw their content with JavaScript look empty until opened. The frame inherits
the app's Content-Security-Policy, which loads no `data:` stylesheets or fonts:
bundled CSS and its `@import`s are inlined, bundled fonts are not, so the preview uses
system fonts. While two other bundles are loading, the preview retries with a short
backoff.

The session's **Artifacts** panel lists that session's artifacts in compact rows that
open the viewer, with the retention hint above them. Each row's ⓘ opens the artifact's
detail on the Artifacts page (pin, delete), and **Manage in Artifacts** opens the page
filtered to the session; the filter shows as a removable chip. Both links are
cross-links (`returnTo`), so the page's back arrow returns to the session.

`GET /api/artifacts` takes `projectId`, `sessionId`, `page`, `q` (up to 200
characters, no control characters) and `pinned=true|false`, and returns
`{ items, page, total, counts: { all, pinned } }`; `counts` follows every filter
except `pinned`. Search also matches session names (from the stored session metadata)
and project names, read at most every 5 seconds; searches share an owner budget of 120
requests per minute and answer `ARTIFACT_RATE_LIMITED` (429) beyond it.

## Publishing and updating

Write a file or directory inside the session working directory, then call:

```json
{
  "requestId": "report-2026-09-19-1",
  "title": "Experiment report",
  "sourcePath": "output/report",
  "entrypoint": "index.html"
}
```

`artifact_publish` returns metadata and the viewer URL. Reuse the same `requestId`
and arguments after an uncertain response. To replace a publication, supply its
`artifactId` and a new `requestId`; its URL and pin remain unchanged. The calling
session identity comes from AgentPier's authenticated integration. A session can
only update its own artifacts. `artifacts_list` lists that session's artifacts in
pages of 20 and needs only the session identity. External OAuth clients do not
receive these session-only tools.

Publishing records the session's current project. When a plain session folder becomes
its own Git work tree, publishing moves the project and the session's earlier artifacts
to the Git identity, so updates keep working without a reload. The rule is described in
[SSH access](ssh-access.md#git-initialization-in-a-session-folder). Any other
project change is rejected with "The project of this session changed. Reload the
session to continue." and audited as `artifact.denied`. A request ID retried across
such a rebind returns a conflict; use a new request ID.

A publication is an independent copy. Editing or removing the source does not
change it. Failed replacements preserve the previous publication. File selection
rejects traversal, symlinks, hard links, special files and changes during copying.
Absolute source paths must still be inside the session working directory.

Every file in a selected directory must have a supported type. Keep documentation
such as `README.md` outside the publication copy. Rejections identify unsupported
files, unsafe links, invalid bundle names, duplicate names and invalid entrypoints;
the MCP returns these explanations in English. Failed uploads do not modify the
source directory or replace a previously published artifact.

Supported entrypoints are HTML documents and individual images. Directory bundles
use an HTML entrypoint and may contain CSS, JavaScript, JSON, images and fonts.
Relative assets, CSS imports, static JavaScript modules and literal dynamic module
imports resolve within the bundle. Use simple ASCII filenames containing letters,
numbers, underscores, dots, spaces or hyphens. Root-relative URLs, external
resources, `srcset`, computed module imports and `import.meta` are unsupported.
Runtime `fetch` is blocked; embed data directly in HTML or JavaScript when it is
needed by the preview. There is no application backend, service worker or network access.

## Retention and limits

Stopping or reloading a session preserves its artifacts. Deleting a session
removes its unpinned artifacts. Pinned artifacts survive in the project overview;
unpinning one whose session has been deleted also deletes it after confirmation.
The owner can delete any artifact manually; deleting it again succeeds without a
second audit entry. There is no age-based expiration or
silent eviction.

Each publication permits up to **50 MiB** and **500 files**. Managed storage is
limited to **1 GiB**, including staged replacements and pending cleanup. Replacing
a large artifact therefore requires temporary space for both versions. The UI
shows total usage and pending cleanup. Abandoned generations and failed physical
deletions are retried at startup and every minute. Logical deletion immediately
makes the artifact unavailable. An already opened tab may retain its loaded copy.

Publication receipts are retained for safe retries, with a limit of 10,000.
The viewer also bounds the transformed document representation to prevent nested
CSS imports or repeated assets from exhausting memory. A bundle below the upload
limit can still be rejected when its expanded representation is too large.

## Isolation and persistence

The server stores private snapshots below `artifacts/` in the data directory.
Each replacement writes a new generation, syncs its files and directories, and
atomically publishes a durable metadata pointer before reclaiming old content.
Session retirement and publication share a serialized queue and the application's
backup mutation barrier.

The authenticated API returns data, never generated HTML as an application page.
The viewer parses and rewrites the bundle into a sandboxed iframe with scripts
allowed but without same-origin, popup or top-navigation privileges. Its CSP
blocks network connections, nested frames, workers, forms and external assets.
Artifact scripts cannot access the parent application's cookies or storage.

Logical backups include pinned artifacts even without session history. With
history enabled they include unpinned artifacts too. Only committed generations
are copied. Restores validate artifact metadata and content and apply project ID
mappings; pinned results remain available even when the original session is gone.
Artifact files stream into the backup archive without a size or count limit
(see [backups.md](backups.md)); artifacts are never silently omitted. Logical
backups omit session MCP credentials as before.
