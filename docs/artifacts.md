# Private artifacts

AgentPier-hosted Codex, Claude Code and OpenCode sessions with **AgentPier tools**
enabled can publish static results using `artifact_publish`. Open **Artifacts** in
the sidebar for the project overview, or expand **Artifacts** in a session.
**Open** displays the result in a separate browser tab, behind the existing owner
login. URLs do not grant access by themselves.

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
pages of 20. External OAuth clients do not receive these session-only tools.

A publication is an independent copy. Editing or removing the source does not
change it. Failed replacements preserve the previous publication. File selection
rejects traversal, symlinks, hard links, special files and changes during copying.
Absolute source paths must still be inside the session working directory.

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
The owner can delete any artifact manually. There is no age-based expiration or
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
Backups currently allow at most **128 MiB** of artifact content and **15,000**
artifact files within the existing archive limits. Larger backups fail explicitly;
artifacts are never silently omitted to fit. Logical backups omit session MCP
credentials as before.
