# File Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einen vollständigen Datei-Explorer unter Verwaltung und im Sitzungskontext
mit Dateiaktionen, Papierkorb, Transfers, ZIP und konfliktbewusstem Editor ausliefern.

**Architecture:** Gemeinsame React-Komponenten verwenden eine explizite globale oder
projektbezogene API. Dateidienste kapseln Pfadauflösung, native Metadaten, persistierte
Jobs und Veröffentlichung; Sitzungsendpunkte bleiben kompatible Adapter.
Byte-Streams und kurz gehaltene Commit-Abschnitte halten lange Transfers von globalen
Anwendungssperren fern.

**Tech Stack:** JavaScript ES modules, JSX, React/Vite, Express, Node.js-Dateistreams,
`node:sqlite`, CodeMirror 6, `koffi`, `yauzl` und `yazl`, `node:test`, fast-check,
Playwright. Quellbasis `356f1d0`; genehmigte Spezifikation aus Commit `5aa5168`.

**Spec:** [2026-09-13-file-explorer-design.md](../specs/2026-09-13-file-explorer-design.md).
Die dortige schriftliche Fassung wurde im Gespräch ausdrücklich bestätigt.

## Global Constraints

- Node.js 22.13+, Git und tmux; macOS und Linux, bestehende CI zusätzlich Node 24.
- „Desktop und Handy sowie deutsche und englische Bedienung gehören zum Umfang.“
- „Die bestehende Sitzungsansicht behält ihren Projektzugriffsbereich.“
- „Neue globale Endpunkte liegen unter `/api/files`; bisherige Sitzungsendpunkte bleiben als kompatible Adapter des Projektkontexts bestehen.“
- „MCP- und Sitzungstoken erhalten keine neue globale Dateiberechtigung.“
- „Es gibt keinen automatischen Rückfall auf endgültiges Löschen.“
- „Es gibt keine automatische Ablaufzeit für Papierkorbinhalte.“
- „Entwürfe bleiben im Arbeitsspeicher“; keine Inhalte in URLs, Jobs, Audit oder Browserdatenbanken.
- „Neu erstellte Dateien erhalten `0600`, neue Ordner `0700`“ unter Prozess-Umask.
- Dateien unter den Strukturprüfungen höchstens 600 Zeilen; JSX/ESM, Prettier und reaktive Nachrichtenexporte.
- Jede neue UI-/Fehlerkennung mit passenden Argumenten in Deutsch und Englisch im selben Commit.
- Alle Tests mit isolierten Datenverzeichnissen; niemals echte Sitzungen oder den Standard-tmux-Server verwenden.
- Neue Pakete über `package-lock.json`, native Bestandteile über Installation **und** Update ausliefern und prüfen.
- Commits, PR-Titel und PR-Beschreibungen auf Englisch; Feature-Branch, geschütztes `main`, CI und aufgelöste Review-Gespräche vor Merge.
- Worktrees unter `.worktrees/`; aktive Spezifikation und Plan behalten, abgeschlossene Arbeitsdokumente vor dem finalen PR/Merge entfernen.

| Grenze aus der Spezifikation | Verbindlicher Anfangswert                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Dateiliste                   | 200 Einträge/Seite, 100.000 Einträge/Snapshot                                                     |
| Suche                        | 100.000 untersuchte Einträge, 10.000 Treffer oder 30 Sekunden                                     |
| Text / Bildvorschau          | 2 MiB / 20 MiB                                                                                    |
| Upload / Jobdaten            | 10 GiB je Datei / 50 GiB je Upload-, Kopier- oder Archivjob                                       |
| Jobstruktur / Parallelität   | 50.000 Einträge, 128 Ebenen / 3 Dateiübertragungen pro Besitzer                                   |
| Aufbewahrung                 | 7 Tage terminale Jobmetadaten; 24 Stunden inaktive unvollständige Uploads; Papierkorb ohne Ablauf |

---

## Lesereihenfolge, Umfang und Ausführung

Dies ist ein zusammenhängendes Subsystem. Die Lieferabschnitte sind keine unabhängig
installierten Produkte: Pfadauflösung, Journal und Konfliktregeln werden gemeinsam
genutzt. Jeder Task endet mit einem eigenständig prüfbaren Ergebnis. Zunächst den
Vertrag unten, dann den eigenen Task und seine genannten Vorgänger lesen.

Die Umsetzung läuft im bestehenden Worktree `.worktrees/file-explorer-design` auf
`chore/file-explorer-design` für PR #79. Tasks 1 und 2 sind implementiert und unabhängig
geprüft; der aktuelle Stand enthält außerdem den gemergten Claude-Fix aus PR #78.
Die lokale Prüfung der Lesegrundlage umfasst 1.409 erfolgreiche Tests unter Node 22,
vier übersprungene Tests und einen realen Installations-/Update-Pakettest. Die
Plattformprüfung dieses Stands erfolgt zusätzlich in der erforderlichen CI.
Die übrigen Tasks bleiben offen. Paketversionen wurden ursprünglich am 2026-09-13
in der npm-Registry gelesen; tatsächliche Installation und Kompatibilität werden
jeweils bei ihrer Einführung geprüft.

Vor Task 1 im gewählten Implementierungs-Worktree `npm ci` und `npm run check`
ausführen und den Ausgangszustand festhalten. Im vorhandenen Planungs-Worktree kann
ein Feature-Branch `feat/file-explorer` vom aktuellen Commit erstellt werden;
keinen zusätzlichen Worktree innerhalb dieses Worktrees anlegen. Bei späterer
Ausführung zuerst den aktuellen Repository-Stand mit der hier genannten Basis
vergleichen. Verschobene Integrationsstellen im Plan korrigieren, bevor Code entsteht.

Pro Task die angegebenen Tests zuerst schreiben und rot ausführen, anschließend
in kleinen Schritten implementieren, grün prüfen und mit dem angegebenen Titel
committen. Codeblöcke zeigen den jeweiligen Vertragskern; die ergänzenden, konkret
benannten Fälle gehören ebenfalls zum Task. Die Tests gegen neue Endpunkte sollen
vor deren Registrierung mit 404 scheitern, nicht wegen eines kaputten Fixtures.

| Lieferabschnitt              | Tasks | Ergebnis                                                         |
| ---------------------------- | ----- | ---------------------------------------------------------------- |
| 1. Zugriff und Navigation    | 1–6   | Globale und projektbezogene Dateiansicht mit Suche               |
| 2. Mutationen und Papierkorb | 7–12  | Metadaten, Veröffentlichung, Wiederherstellung und Dateiaktionen |
| 3. Transfers und ZIP         | 13–17 | Streaming, Upload-Oberfläche und Archive                         |
| 4. Editor                    | 18–20 | Revisionen, Tabs, Sprachen und Navigationsschutz                 |
| 5. Auslieferung              | 21–23 | Bedienung, Plattformabnahme, Betriebsdokumentation und PR        |

## Geplante Dateigrenzen

Alle unten als neu bezeichneten Dateien entstehen erst bei der Umsetzung.

| Bereich              | Dateien und Verantwortung                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kontext              | `server/features/files/file-scope.js` (Kontext), `file-paths.js` (Auflösung), `file-errors.js` (stabile Fehler), `file-limits.js` (validierte Grenzen)                                                                                                   |
| Lesen                | `file-listing.js` (Snapshots), `file-reading.js` (Vorschau), `file-search.js` (Suche/Größe), `file-preferences.js` (hostbezogene Favoriten)                                                                                                              |
| Dauerhaftigkeit      | `file-store.js` (SQLite-Zugriff), `file-schema.js` (Schema), `file-jobs.js` (Zustände), `file-job-handlers.js` (Handler), `file-locks.js` (Pfadsperren), `file-recovery.js` (Wiederanlauf)                                                               |
| Plattform            | `file-native.js` (Worker-Port), `file-native-worker.js` (begrenzte FFI-Aufträge), `file-native-linux.js`, `file-native-darwin.js` (ABI), `file-metadata.js` (Metadatenvertrag)                                                                           |
| Schreiben            | `file-publish.js` (Veröffentlichung), `file-mutations.js` (Erstellen/Umbenennen), `file-tree-transfer.js` (geprüfte Baumübertragung), `file-copy.js` (Kopieren/Verschieben), `file-trash.js` (Papierkorb), `file-text.js` (Kodierung/Revision/Speichern) |
| Transfers            | `file-uploads.js` (Upload-Lebenszyklus), `file-downloads.js` (Download), `file-zip.js` (ZIP schreiben), `file-extract.js` (ZIP lesen), `file-archive-paths.js` (Archivpfade)                                                                             |
| Integration          | `server/application/files.js` (Dienstzusammenbau), `server/http/routes/file-explorer.js`, `file-operations.js`, `file-transfers.js`, `file-text.js` (schmale HTTP-Adapter)                                                                               |
| Oberfläche           | `web/features/files/FilesPage.jsx`, `ExplorerWorkspace.jsx`, `ExplorerToolbar.jsx`, `DirectoryTree.jsx`, `FileList.jsx`, `FileProperties.jsx`, `FileActions.jsx`, `FileConflictDialog.jsx`, `FileJobs.jsx`, `TrashView.jsx`                              |
| Clientzustand        | `file-api.js`, `routes.js`, `useFileListing.js`, `useFileSelection.js`, `useFileJobs.js`, `useFileClipboard.js`, `useFilePreferences.js`, `useFileUploads.js`, `file-upload-selection.js` unter `web/features/files/`                                    |
| Editor               | `FileEditor.jsx`, `FileEditorTabs.jsx`, `FileEditorConflict.jsx`, `file-editor-state.js`, `file-editor-languages.js`, `useFileEditor.js`, `useFileNavigationGuard.js`, `file-navigation-guard.js` unter `web/features/files/`                            |
| Stil und Texte       | Bestehendes `files.css`; neue `file-editor.css`, `file-actions.css`, `file-transfers.css`; passende `files.js`, `file-editor.js`, `file-transfers.js` in `web/lib/i18n/{de,en,messages}/`                                                                |
| Dauerhafte Anleitung | `docs/file-explorer.md`, Ergänzungen in `docs/architecture.md`, `docs/installation.md`, `docs/linux.md`, `THIRD_PARTY_NOTICES.md`                                                                                                                        |

Keine breite Änderung des allgemeinen Operations-Jobdienstes: dessen Release- und
Backup-Jobs haben andere Lebenszyklen. Wiederverwenden: `privateDatabase`, vorhandene
Anmeldung, `MutationBarrier`, Modal, Drop-Hook und Testfixture-Grundlagen.

## Gemeinsamer Daten- und API-Vertrag

Die folgenden Typen sind JSDoc-Verträge, keine Umstellung des Projekts auf TypeScript.
Jeder Task verwendet diese Feldnamen unverändert. Kein Client darf `root`, `home`,
`readOnly` oder einen Betriebssystem-Benutzer als Autorisierungsparameter setzen.

```js
/** @typedef {{kind:"global"|"project", id:string, root:string,
 * home:string, sessionId:string|null, readOnly:boolean}} FileScope */
/** @typedef {{path:string, name:string, type:"file"|"directory"|"symlink"|"special",
 * size:number|null, modifiedAt:string|null, mode:number, readable:boolean|null,
 * writable:boolean|null, linkTarget:string|null, revision:string|null}} FileEntry */
/** @typedef {{path:string, parent:string|null, entries:FileEntry[], total:number,
 * page:number, pageSize:number, hasMore:boolean, snapshotId:string}} FileListing */
/** @typedef {{code:string, args:Object<string,string|number|boolean>}} FileIssue */
/** @typedef {{requestId:string, kind:string, sources:string[], target:string|null,
 * name:string|null, options:object}} FileOperation */
/** @typedef {{id:string, kind:string, scopeId:string, status:string,
 * completedEntries:number, totalEntries:number|null, completedBytes:number,
 * totalBytes:number|null, conflict:object|null, issue:FileIssue|null}} FileJob */
/** @typedef {{text:string, revision:string, path:string, resolvedPath:string,
 * encoding:"utf-8", bom:boolean, lineEnding:"lf"|"crlf"|"mixed",
 * readOnly:boolean}} FileDocument */
```

Globale Pfade sind absolut, Projektpfade relativ zur kanonischen Projektwurzel.
`FileScope.id` bindet Projekt-ID und kanonische Wurzel; geändertes Sitzungs-CWD
invalidiert alte Mutationen. HTTP-Schreibanfragen senden `X-File-Scope`; der Server
vergleicht den Wert mit seinem frisch abgeleiteten Kontext. Der Header ist kein
Zugangstoken. `revision` ist ein undurchsichtiger serverseitiger Fingerabdruck.
Auflistung und Eigenschaften liefern `e1:`-Revisionen aus stat-/Link-Identität;
dafür werden keine Inhalte gelesen. Textdokumente liefern `d1:`-Revisionen mit
zusätzlichem Inhaltshash. Namens-/Verschiebekonflikte verwenden die `e1:`-Variante,
Textspeichern die `d1:`-Variante. Die Veröffentlichung validiert die übergebene
Variante ausdrücklich und lehnt unbekannte Varianten ab.

Der globale API-Präfix ist `/api/files`, der neue Projektpräfix
`/api/sessions/:id/files/explorer`. Jeder Endpoint unten existiert hinter beiden
Präfixen, soweit der Projektkontext die Aktion zulässt. Die drei bisherigen
`/api/sessions/:id/files`-Endpunkte behalten Form, Pfade und Vorschaugrenzen.

| Methode und Suffix                                            | Vertrag / Task                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /context`                                                | `{scopeId, kind, root, home, readOnly, limits}`; Task 3                                               |
| `GET /entries?path=&page=&sort=&direction=&hidden=&snapshot=` | `FileListing`; Task 3                                                                                 |
| `GET /metadata?path=` / `GET /preview?path=`                  | `FileEntry` / `{type:"text"                                                                           | "image", text?, source?}`; Task 3 |
| `GET/PATCH /preferences`                                      | `{favorites:[{id,name,path}], showHidden}`; Projektadapter filtert ausbrechende Favoriten; Task 4     |
| `POST /operations`                                            | `FileOperation` → HTTP 202, `FileJob`; unbekannte/noch nicht registrierte Arten ablehnen; Task 5      |
| `GET /jobs?cursor=` / `GET /jobs/:id`                         | Begrenzte Jobliste / `FileJob`; Task 5                                                                |
| `GET /jobs/:id/entries?cursor=`                               | `{entries, nextCursor}`; nie gesamtes Manifest in Jobprojektion; Task 5                               |
| `POST /jobs/:id/cancel`                                       | Idempotent, aktueller `FileJob`; Task 5                                                               |
| `POST /jobs/:id/resolve`                                      | `{conflictId, decision, applyToRemaining}`; revisiongebunden; Task 11                                 |
| `GET /trash?cursor=`                                          | `{entries:[{id, originalPath, deletedAt, type, size, reason}], nextCursor}`; Task 9                   |
| `POST /upload-groups`                                         | `{requestId,path}` → `{groupId,job}`; Task 13                                                         |
| `POST /upload-groups/:id/entries`                             | `{batchId,entries:[{id,relativePath,type,bytes}]}` in Batches bis 60 KiB → bestätigte Zähler; Task 13 |
| `POST /upload-groups/:id/commit`                              | Validiertes Manifest abschließen, Ordner anlegen → `FileJob`; Task 13                                 |
| `POST /uploads`                                               | `{requestId, path, name, bytes, scopeId, groupId?, entryId?}` → `{job, uploadId}`; Task 13            |
| `PUT /uploads/:id/content`                                    | `application/octet-stream`, `Content-Length` soweit bekannt; finaler `FileJob`; Task 13               |
| `GET /download?path=`                                         | Byte-Stream als Attachment; Task 13                                                                   |
| `GET /jobs/:id/download`                                      | Fertiges ZIP-Download-Artefakt als Stream; Task 15                                                    |
| `GET /text?path=`                                             | `FileDocument`; Task 18                                                                               |
| `PUT /text?path=`                                             | UTF-8-Bytes, `If-Match`, `X-File-Scope`, `X-File-Request`; `{revision,path}`; Task 18                 |

Operation-Arten: `create_file`, `create_directory`, `rename`, `copy`, `move`,
`trash`, `restore`, `purge`, `archive`, `extract`, `search`,
`size`. Für `restore`/`purge` enthalten `sources` Papierkorb-IDs, für alle anderen
Arten Pfade. `options` wird pro Art mit einer Whitelist validiert; keine beliebigen
Dateisystemflags. `archive` verwendet `options.output` gleich `file` oder `download`.
`upload` und `upload_group` sind interne Jobarten, die ausschließlich Upload-Routen
reservieren und beim Byte-Empfang ausführen; `POST /operations` akzeptiert sie nicht.

Fehlertransport: `{error:"safe fallback", code, args}`. Status 400 für ungültige
Eingaben, 403 für Rechte/Kontext, 404 für fehlende Einträge, 409 für Konflikte,
410 für abgelaufene Aufträge, 413 für Grenzen, 415 für ungeeignete Dateitypen,
503 für fehlende native Unterstützung. `file-api.js` übersetzt `code` reaktiv und
bewahrt `status`, `code`, `args`; native Fehlermeldungen und Inhalte werden nicht
als zusätzliche Diagnosefelder ausgeliefert.

Jobzustände exakt wie in der Spezifikation. SQL-Tabellen: `jobs`, `job_entries`,
`requests`, `publications`, `trash_entries`. Upload-Gruppen verwenden einen
`upload_group`-Elternjob und dessen `job_entries` als Manifest; Child-Upload-Jobs
tragen `parentJobId` und `entryId`. Auftrags-/Papierkorb-/Publikationsdaten
liegen unter `<dataDir>/files/`; Byte-Arbeitsbereiche können zusätzlich in einem
privaten Unterverzeichnis des Ziel-Elternordners liegen, damit Veröffentlichung
innerhalb desselben Dateisystems möglich bleibt. Das Journal kennt jeden solchen
Pfad und dessen Eigentums-/Identitätsdaten; ein Cleaner darf keine Namenmuster
außerhalb dieser registrierten Einträge pauschal löschen.

## Paketentscheidungen und technische Belege

`koffi@3.2.1` bindet kleine native Metadaten- und Rename-Funktionen an. Seine
plattformbezogenen optionalen Pakete müssen im Release enthalten bleiben; Koffi 3
verteilt native Bestandteile über diese Pakete. Das muss der Release-Smoke-Test
nachweisen. [Koffi-Plattformen](https://koffi.dev/),
[Paketaufteilung](https://koffi.dev/migration).

Darwin kopiert Metadaten über `fcopyfile` an bereits offenen Deskriptoren;
Linux verwendet begrenzte fd-bezogene xattr-Aufrufe einschließlich POSIX-ACL-xattrs.
Das ist eine Implementierungsentscheidung aus dem Metadatenerhalt der Spezifikation.
[Apple fcopyfile](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.3),
[Linux flistxattr](https://man7.org/linux/man-pages/man2/flistxattr.2.html),
[Linux fgetxattr](https://man7.org/linux/man-pages/man2/fgetxattr.2.html).

Für vorhandene Ziele wird ein atomarer Austausch mit erhaltener verdrängter Datei
geplant. Nicht unterstützte Dateisysteme melden dies vor destruktiven Änderungen;
sie fallen nicht auf ungeprüftes Überschreiben zurück.
[Linux renameat2](https://man7.org/linux/man-pages/man2/rename.2.html),
[Apple Rename-Flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h).

ZIP-Erstellung verwendet `yazl@3.3.1`; die vorhandene `yauzl`-Abhängigkeit liest
Archive mit `lazyEntries` und Größenvalidierung. Beide unterstützen Stream-Zugriffe.
[yazl](https://github.com/thejoshwolfe/yazl),
[yauzl](https://github.com/thejoshwolfe/yauzl).

Editor-Pins: `@codemirror/state@6.7.4`, `view@6.43.11`, `commands@6.11.0`,
`search@6.7.2`, `language@6.12.4`, `merge@6.12.2`, `lang-javascript@6.2.5`,
`lang-json@6.0.2`, `lang-html@6.4.12`, `lang-css@6.3.1`, `lang-markdown@6.5.2`,
`lang-python@6.2.1`, `lang-yaml@6.1.3`, `legacy-modes@6.5.4` (jeweils unter
`@codemirror/`). Die offiziellen Module liefern
[Zustand](https://github.com/codemirror/state),
[Darstellung](https://github.com/codemirror/view) und
[Suche](https://github.com/codemirror/search); Tabs und Navigationsschutz bleiben
AgentPier-Verantwortung. Für Details der Architekturentscheidung gilt die Spezifikation.

## Task 1: Zugriffskontext, Pfade und Grenzen

**Files:** Create `server/features/files/{file-scope,file-paths,file-errors,file-limits}.js`,
`tests/helpers/file-explorer.js`, `tests/unit/file-scope.test.js`,
`tests/property/file-paths.test.js`; Modify `server/lib/config.js`.

**Interfaces:** Produces `makeFileScope({home, session = null}) → Promise<FileScope>`,
`resolveFile(scope, input, {followLeaf = true, allowMissingLeaf = false}) → Promise<{path,absolute,parent,name,stat,linkIdentity}>`,
`entryRevision(stat,linkIdentity=null) → string` (Präfix `e1:`),
`readFileLimits(overrides = {}) → limits`, `fileProblem(code, status, args = {})`.
`fileFixture(t)` returns `{root,home,project,dataDir,globalScope,projectScope}` and
registers cleanup of only its unique root. Project context uses a fabricated
`{id:"fixture",cwd:project}` without starting a session.

- [x] Write the traversal regression and properties for adjacent-prefix paths, absolute project inputs, NUL, missing leaves, dangling links, link loops and an escaping parent link.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileFixture } from "../helpers/file-explorer.js";
import { resolveFile } from "../../server/features/files/file-paths.js";
test("global navigation follows an OS-accessible link while project scope rejects it", async (t) => {
  const f = await fileFixture(t);
  await fs.symlink(f.home, path.join(f.project, "outside"));
  await assert.rejects(resolveFile(f.projectScope, "outside"), {
    code: "FILE_OUTSIDE_SCOPE",
  });
  const found = await resolveFile(f.globalScope, path.join(f.project, "outside"));
  assert.equal(found.absolute, f.home);
});
```

- [x] Run `node --test tests/unit/file-scope.test.js tests/property/file-paths.test.js`; confirm the unimplemented resolver is the failure.
- [x] Implement context construction from trusted configuration/session data, normalize `~`, and separate resolving a selected link from following it. Check existing parent identity again before mutations; leaf names must be one segment, at most 255 UTF-8 bytes, with no NUL/control characters or slash. Global canonical `/` and project root are readable contexts, not deletion targets.

Use `stat({bigint:true})` internally for revision fields `dev`, `ino`, `mode`,
`uid`, `gid`, `size`, `mtimeNs` and `ctimeNs`, serialized as decimal strings before
hashing. Do not include access time, which changes merely because a file is read.
Public sizes remain bounded numbers; never serialize a raw BigInt into HTTP JSON.

```js
export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export function fileProblem(code, status, args = {}) {
  return Object.assign(new Error("File operation failed."), { code, status, args });
}
```

- [x] Add exact numerical defaults from Global Constraints to `readFileLimits`; reject unknown keys, zero, non-integers and unsafe integers. `loadConfig()` reads optional saved `files.limits`; test overrides without touching real config files. Implement fixture creation using `fs.mkdtemp`, `fs.realpath`, modes `0700` and `t.after`.

```js
export const defaultFileLimits = Object.freeze({
  listPageSize: 200,
  listEntries: 100000,
  searchEntries: 100000,
  searchResults: 10000,
  searchMs: 30000,
  textBytes: 2 * 1024 ** 2,
  imageBytes: 20 * 1024 ** 2,
  uploadBytes: 10 * 1024 ** 3,
  jobBytes: 50 * 1024 ** 3,
  jobEntries: 50000,
  maxDepth: 128,
  transfers: 3,
  jobsRetentionMs: 7 * 86400000,
  uploadRetentionMs: 86400000,
});
export async function fileFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-files-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(home, "project"),
    dataDir = path.join(root, "data");
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  await fs.mkdir(dataDir, { mode: 0o700 });
  return {
    root,
    home,
    project,
    dataDir,
    globalScope: await makeFileScope({ home }),
    projectScope: await makeFileScope({ home, session: { id: "fixture", cwd: project } }),
  };
}
```

- [x] Re-run the two tests and `node --test tests/unit/i18n-catalogs.test.js`; inspect failures before expanding testing.
- [x] Commit this task's files: `git commit -m "feat: define file explorer scopes and limits"`.

## Task 2: Begrenzte Auflistung, Eigenschaften und Vorschau

**Files:** Create `server/features/files/{file-listing,file-reading}.js`,
`tests/integration/file-listing.test.js`, `tests/integration/file-preview.test.js`;
Modify `server/features/files/project-files.js` only to share safe reading primitives.

**Interfaces:** Consumes Task 1. Produces `FileListingStore({limits, now = Date.now})`
with `list(scope, {path,page=1,sort="name",direction="asc",hidden=false,snapshot=null}) → Promise<FileListing>`,
`metadata(scope,path) → Promise<FileEntry>`, `preview(scope,path,{legacy=false}) → Promise<object>`.
Snapshots expire after 30 seconds; limit to 8 snapshots per owner, evict only unused
entries. A stale supplied snapshot returns 409, never a misleading page.

- [x] Write real-file tests for directory-first ordering, all four sort fields, hidden `.git`, stable pages, permission-denied metadata, special files and snapshots expiring with an injected clock.

```js
test("a growing UTF-8 preview stops at the byte limit", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.home, "large.txt");
  await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(preview(f.globalScope, file), { code: "FILE_LIMIT_EXCEEDED" });
});
```

- [x] Run `node --test tests/integration/file-listing.test.js tests/integration/file-preview.test.js` and observe red.
- [x] Enumerate with `fs.opendir`; stop explicitly at the snapshot cap before sorting. Return symlinks even when dangling, and represent permission hints as `null` when unknown. Never read file contents for listing. Use an opened regular-file descriptor and bounded read to detect image magic and fatal UTF-8 decoding.

```js
// First inspect bounded magic bytes, then select text/image and its own byte limit.
const limit = legacy ? 256 * 1024 : limits.textBytes;
const buffer = Buffer.alloc(limit + 1);
let used = 0;
while (used < buffer.length) {
  const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
  if (!bytesRead) break;
  used += bytesRead;
}
if (used > limit) throw fileProblem("FILE_LIMIT_EXCEEDED", 413, { limit });
const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
```

- [x] Keep legacy text/image limits and response shape. New image preview accepts only PNG/JPEG/GIF/WebP up to 20 MiB; SVG/HTML remain escaped text. Close descriptors in `finally`, including invalid UTF-8 and aborted reads.
- [x] Run the new tests plus `node --test tests/integration/workspace-files.test.js`.
- [x] Commit: `git commit -m "feat: add bounded file listings and previews"`.

## Task 3: Besitzer-API, Fehlerübersetzung und globale Route

**Files:** Create `server/application/files.js`, `server/http/routes/file-explorer.js`,
`web/features/files/{file-api,routes}.js`, `tests/blackbox/file-access.test.js`,
`tests/unit/file-routes.test.js`; Modify `server/application/services.js`,
`server/app.js`, `server/http/security.js`, `web/app/routes.js`, and all three
`web/lib/i18n/{de,en,messages}/files.js` plus `server/lib/i18n/de/files.js`.

**Interfaces:** `createFileServices({config,sessions,mutationBarrier})` assembles
`{context,listings,reading,limits,close}` and is extended by later tasks without changing
these names. `context(sessionId=null)` re-reads sessions and returns `FileScope`.
`fileApi(scopeRef)` returns `{get, mutate, raw, base}`; `scopeRef` is `{kind,sessionId?}`,
not a trusted root. `readExplorerRoute(search)` and `explorerQuery(route)` own URL fields.

- [ ] Write HTTP and route round-trip regressions. Reuse `applicationFixture`; import every helper used in the snippets.

```js
test("machine tokens cannot read the global filesystem", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/files/context", {
    headers: { authorization: "Bearer fixture-machine-token" },
  });
  assert.equal(response.status, 403);
});
test("authenticated owner gets a global context", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/files/context");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).home, f.home);
});
```

- [ ] Run `node --test tests/blackbox/file-access.test.js tests/unit/file-routes.test.js`; the positive endpoint case must be red before routing exists.
- [ ] Mount read endpoints after login/origin guards. Derive contexts exclusively from route parameters and server state. Headless project contexts report `readOnly:true` and reject future writes on the server. Add `/files` to the known HTML-route regex; global deep links accept URL-encoded absolute paths.

```js
router.get("/context", async (req, res) => {
  const scope = await files.context(req.params.id || null);
  res.json({
    scopeId: scope.id,
    kind: scope.kind,
    root: scope.root,
    home: scope.home,
    readOnly: scope.readOnly,
    limits: files.limits,
  });
});
```

- [ ] Add a route-local error serializer and translate stable codes in `fileApi`; dispatch the existing login-required event on 401. Test no-login, wrong origin, cross-site API access, global/project separation and path-looking error text remaining inert. Extend route property tests to cover spaces, Unicode, `#`, `%`, hidden/filter/sort/page state and malformed query values.
- [ ] Run new tests plus `tests/unit/routes.test.js`, `tests/property/routes.test.js`, `tests/unit/i18n-catalogs.test.js`, `tests/integration/workspace-files.test.js` with `node --test`.
- [ ] Commit: `git commit -m "feat: expose owner-scoped file explorer APIs"`.

## Task 4: Verwaltungsoberfläche, gemeinsame Sitzungsansicht und Favoriten

**Files:** Create `web/features/files/{FilesPage,ExplorerWorkspace,ExplorerToolbar,DirectoryTree,FileList,FileProperties}.jsx`,
`{useFileListing,useFilePreferences}.js`, `server/features/files/file-preferences.js`,
`tests/browser/file-explorer-navigation.spec.js`, `tests/integration/file-preferences.test.js`;
Modify `web/app/{App,Sidebar}.jsx`, `web/features/files/{FileExplorer.jsx,files.css}`,
`server/http/routes/file-explorer.js`, `server/application/files.js` and paired files catalogs.

**Interfaces:** `ExplorerWorkspace({scopeRef,route,navigate})` owns shared views;
`FilesPage` supplies the global scope; existing `FileExplorer({session,route,navigate})`
supplies a project scope. `useFileListing({client,path,page,sort,direction,hidden})`
returns `{listing,error,loading,refresh}` and aborts obsolete reads.
`FilePreferences({dataDir,home}).get(scope)` / `.update(scope,patch)` expose only
favorites within scope. Persist in `<dataDir>/files/preferences.json`, tied to a
host identity derived from canonical home and data directory; global preferences
are not added to `/api/state` or copied into project metadata.

- [ ] Add desktop and 390-pixel browser cases with existing repository-browser fixtures and explicit `/api/files/**` routes, plus real preference persistence tests.

```js
test("English management opens Files and keeps its path after reload", async ({
  page,
}) => {
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&hidden=1");
  await expect(page.getByRole("region", { name: "Files" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("/home/test");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
```

- [ ] Build then run `npx playwright test tests/browser/file-explorer-navigation.spec.js`; set English through the application's existing language control in the fixture, not by translating locators alone.
- [ ] Lazy-load `FilesPage` in `App.jsx`; add a localized navigation item. Make toolbar, directory tree and list controlled components; use AbortController when paths change. Preserve legacy session URLs and existing create-directory behavior until the mutation UI replaces that control.

```jsx
const FilesPage = lazy(() => import("../features/files/FilesPage.jsx"));
// Within the existing view selection:
<Suspense fallback={<p role="status">{copy.workspaceLoading}</p>}>
  <FilesPage route={route} navigate={navigate} />
</Suspense>;
```

- [ ] Implement path entry, breadcrumbs, back/forward, sort, hidden files, expandable tree, explicit property view and favorite add/remove. Load project shortcuts from the existing repositories API only in the global view. On mobile provide a single content column and a tree drawer; keep all actions reachable without hover.
- [ ] Run `node --test tests/integration/file-preferences.test.js tests/unit/i18n-catalogs.test.js`, then build and run the new browser suite plus `workspace-files.spec.js` and `sidebar.spec.js` in both browsers using `AGENTPIER_TEST_BROWSER`.
- [ ] Commit: `git commit -m "feat: add the shared management file explorer"`.

## Task 5: Dauerhafte Jobs, Idempotenz und überlappende Pfadsperren

**Files:** Create `server/features/files/{file-schema,file-store,file-jobs,file-job-handlers,file-locks}.js`,
`server/http/routes/file-operations.js`, `tests/unit/file-locks.test.js`,
`tests/integration/file-jobs.test.js`, `tests/blackbox/file-jobs.test.js`;
Modify `server/application/files.js` and `server/app.js`.

**Interfaces:** `FileStore({dataDir,now=Date.now})` owns SQL tables from the shared
contract; methods `request(scope,operation) → {job,created}`, `getJob(scope,id)`, `listJobs(scope,cursor)`,
`putEntry(jobId,entry)`, `listEntries(scope,id,cursor)`, `transition(id,from,to,patch)`,
`putPublication(record)`, `getPublication(id)`, `listPublications()`,
`putTrash(record)`, `getTrash(id)`, `listTrash(scope,cursor)`, `prune(now)`, `close()`.
`FileJobs({store,locks,barrier,limits,handlers,now})` provides
`start(scope,operation) → FileJob`, `get/list/entries`, `cancel(scope,id)`,
`resolve(scope,id,decision)`, `reserve(scope,operation) → FileJob`,
`runReserved(scope,id,handler) → Promise<FileJob>`, `close()`; reserved upload jobs
start their handler and consume a transfer slot only when bytes arrive.
`handlers` is a private Map of allowed kind
to `async ({scope,operation,jobId,signal,report,conflict})`.
`report(patch) → Promise<void>` persists bounded progress; `conflict(info) → Promise<decision>`
suspends through the journal. `PathLocks.withPaths(canonicalPaths, action, signal)`
excludes overlapping parent/child paths, releases on thrown errors and supports
cancelling queued waiters. Nested calls may reuse an already covering lease using
AsyncLocalStorage; attempting to enlarge a held lease fails instead of deadlocking.

- [ ] Write tests for durable same-key/same-body reuse, same-key/different-body rejection, restart to `interrupted`, scoped reads, cancellation, fairness and parent/child exclusion.

```js
test("duplicate starts run one handler and reuse the durable job", async (t) => {
  const f = await fileFixture(t);
  const store = new FileStore({ dataDir: f.dataDir });
  t.after(() => store.close());
  let calls = 0;
  const jobs = new FileJobs({
    store,
    locks: new PathLocks(),
    barrier: new MutationBarrier(),
    limits: readFileLimits(),
    handlers: new Map([
      [
        "size",
        async () => {
          calls++;
        },
      ],
    ]),
  });
  t.after(() => jobs.close());
  const op = {
    requestId: `${Date.now()}:${randomUUID()}`,
    kind: "size",
    sources: [f.home],
    target: null,
    name: null,
    options: {},
  };
  const first = jobs.start(f.globalScope, op);
  assert.equal(jobs.start(f.globalScope, op).id, first.id);
  await jobs.close();
  assert.equal(calls, 1);
});
```

- [ ] Run `node --test tests/unit/file-locks.test.js tests/integration/file-jobs.test.js tests/blackbox/file-jobs.test.js` and confirm red.
- [ ] Create SQLite via `privateDatabase(<dataDir>/files,"files.sqlite")`; keep items in `job_entries`, not a growing JSON array in one job. Give requests a unique `(scope_id,request_id)` index and a canonical-body digest. Request IDs are `timestamp:uuid`: reject more than five minutes in the future or more than seven days old with 400/410, so pruned metadata cannot cause an old mutation to execute anew.

```sql
CREATE TABLE requests (
  scope_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL,
  job_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id, request_id)
);
CREATE TABLE publications (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, phase TEXT NOT NULL,
  document TEXT NOT NULL, updated_at INTEGER NOT NULL
);
```

- [ ] Implement state transitions as conditional SQL updates. Persist request and queued job in one transaction before launching a handler. Barrier leases surround short state/publication changes; do not wrap the whole handler. Validate scope again when a queued job starts. Limit active byte-transfer handlers to three, while reads and cancellation remain responsive.
- [ ] Implement `store.prune(now)` for terminal jobs older than seven days, excluding every job referenced by an unresolved publication, unfinished child or trash record. Invoke it during startup and hourly with an unreferenced timer; shutdown clears the timer. Test an old interrupted publication surviving the sweep and an expired request returning 410 after its job metadata has gone.
- [ ] Register only implemented handlers; currently no browser can trigger an arbitrary operation. On shutdown reject new jobs, abort active work, await owned workers/streams and then close the store. Integrate this lifecycle into the existing application-close path before dependent stores close.
- [ ] Run the three new suites plus existing mutation-barrier tests located with `rg --files tests | rg mutation`; commit: `git commit -m "feat: add recoverable file jobs and path locks"`.

## Task 6: Rekursive Suche und angeforderte Ordnergröße

**Files:** Create `server/features/files/file-search.js`,
`web/features/files/{FileJobs.jsx,useFileJobs.js}`, `tests/integration/file-search.test.js`,
`tests/browser/file-explorer-search.spec.js`; Modify handler registration,
`ExplorerToolbar.jsx`, `FileProperties.jsx`, `ExplorerWorkspace.jsx`, paired files catalogs.

**Interfaces:** `searchFiles({scope,operation,signal,report,store,jobId,limits,now})`
and `measureFiles(same arguments)` are handlers. Search options:
`{query,recursive,caseSensitive,hidden}`. Each result uses a stable `job_entries.id`
and `FileEntry` data. `useFileJobs(client)` exposes `{jobs,entries,start,cancel,resolve,refresh}`
with 1.5-second polling while visible, 10 seconds while hidden and no overlap between requests.

- [ ] Add symlink-cycle, denied-subdirectory, timeout, cap and cancellation tests using a deterministic clock and low fixture limits.

```js
test("search reports truncation and never walks an escaping link", async (t) => {
  const f = await applicationFixture(t, { files: { limits: { searchEntries: 2 } } });
  await fs.mkdir(path.join(f.home, "src"));
  await fs.writeFile(path.join(f.home, "src", "a.txt"), "a");
  await fs.writeFile(path.join(f.home, "src", "b.txt"), "b");
  await fs.symlink(f.root, path.join(f.home, "cycle"));
  const started = await f.request("/api/files/operations", {
    method: "POST",
    headers: {
      "x-file-scope": (await (await f.request("/api/files/context")).json()).scopeId,
    },
    body: {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind: "search",
      sources: [f.home],
      target: null,
      name: null,
      options: { query: ".txt", recursive: true, hidden: false, caseSensitive: false },
    },
  });
  assert.equal(started.status, 202);
  const job = await waitForFileJob(f, (await started.json()).id);
  assert.equal(job.issue.code, "FILE_SEARCH_INCOMPLETE");
});
```

- [ ] Add `waitForFileJob(f,id,{base="/api/files",states=["completed","partially_completed","failed","cancelled","interrupted"],timeout=5000}={})` to `tests/helpers/file-explorer.js`. Poll only this isolated test job, with a bounded timeout and assertions on response status. Run `node --test tests/integration/file-search.test.js`.
- [ ] Traverse iteratively with `opendir`, an explicit depth stack and no link following. Stop on signal, clock, entry, result or byte limits; persist an incomplete reason. Count size only for an explicit `size` job, never in ordinary listing. Check scope on each visited directory.

```js
for await (const entry of directory) {
  signal.throwIfAborted();
  if (++visited > limits.searchEntries || now() >= deadline) {
    incomplete = true;
    break;
  }
  if (entry.isSymbolicLink()) continue;
  // Match entry.name using the declared case and hidden options before descending.
}
```

- [ ] Add query, recursive and case controls; display scanned count, partial results and a stop button. Result selection navigates to the containing folder and active file. Properties start a size job and display its known/unknown state without showing a false zero.
- [ ] Run backend tests, build, then both browsers for `file-explorer-search.spec.js` and `file-explorer-navigation.spec.js`; commit: `git commit -m "feat: add bounded recursive file search"`.

## Task 7: Native Metadaten und auslieferbare Plattformanbindung

Die reine Lesegrundlage (`FileNative`, Worker, Plattform-Öffnen, Koffi und echte
Paket-/Update-Prüfung) wurde als Voraussetzung für Task 2 vorgezogen. Task 7 erweitert
diese vorhandenen Schnittstellen für Metadaten und Umbenennen; diese Arbeit und ihre
Abnahme bleiben vollständig offen. Die gemeldete Koffi-Installationswarnung zur
npm-Skriptfreigabe wird dabei mit der bestehenden Paketkonfiguration abgeglichen.

**Files:** Create `server/features/files/{file-native,file-native-worker,file-native-linux,file-native-darwin,file-metadata}.js`,
`tests/integration/file-native.test.js`, `tests/integration/file-metadata.test.js`;
Modify `package.json`, `package-lock.json`, `server/features/operations/release-archive.js`,
`tests/integration/release-package-output.test.js`, `tests/integration/operations-release.test.js`,
`THIRD_PARTY_NOTICES.md`.

**Interfaces:** `FileNative({platform=process.platform})` exposes
`run(operation,args) → Promise<result>` and `close()`, with a fixed internal allowlist.
`readMetadata(handle) → Promise<{mode,uid,gid,mtimeNs,atimeNs,acl,xattrs,fingerprint}>`,
`copyMetadata(sourceHandle,targetHandle,{strictOwnership,preserveTimes}) → Promise<{warnings:FileIssue[]}>`,
`assertMetadata(expected,actual,{strictOwnership})` live in `file-metadata.js`.
Native port also produces `renameNoReplace(oldParentFd,oldName,newParentFd,newName)`
and `exchange(oldParentFd,oldName,newParentFd,newName)` for Task 8.

- [ ] Write native tests that open real files, attach a harmless xattr and ACL, copy metadata, verify contents are untouched and compare permissions/ownership/ACL/xattrs. Add real directory and link-metadata cases, unsupported namespace, bounded metadata and simulated errno tests.

```js
test("metadata copying leaves bytes untouched and retains executable mode", async (t) => {
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.home, "source"), "wx+", 0o750);
  const target = await fs.open(path.join(f.home, "target"), "wx+", 0o600);
  t.after(async () => {
    await source.close();
    await target.close();
  });
  await source.writeFile("source");
  await target.writeFile("target");
  await copyMetadata(source, target, { strictOwnership: true, preserveTimes: true });
  assert.equal((await target.stat()).mode & 0o777, 0o750);
  assert.equal(await fs.readFile(path.join(f.home, "target"), "utf8"), "target");
});
```

- [ ] Run `node --test tests/integration/file-native.test.js tests/integration/file-metadata.test.js` before installing/implementing the adapter.
- [ ] Install `npm install --save-exact koffi@3.2.1`. Implement the native ABI only in platform files. Linux binds fd-based `flistxattr`, `fgetxattr`, `fsetxattr`, `fremovexattr` and `renameat2`; Darwin binds `fcopyfile`, fd xattr functions, ACL get/set/compare and `renameatx_np`. Use platform headers from the linked primary sources for constants; map names to fixed operations, never accept a symbol/library path from HTTP.

```js
// Linux worker declarations; file descriptor lifetimes remain owned by the caller.
const libc = koffi.load("libc.so.6");
const list = libc.func("ssize_t flistxattr(int fd, _Out_ void *list, size_t size)");
const get = libc.func(
  "ssize_t fgetxattr(int fd, const char *name, _Out_ void *value, size_t size)",
);
const rename = libc.func(
  "int renameat2(int oldfd, const char *oldname, int newfd, const char *newname, unsigned int flags)",
);
const required = list(fd, null, 0);
if (required < 0) return { ok: false, errno: koffi.errno() };
if (required > 65536) return { ok: false, code: "FILE_METADATA_LIMIT" };
const names = Buffer.alloc(required);
const received = list(fd, names, names.length);
```

- [ ] Cap attribute names at 256, aggregate values at 8 MiB and retry growing metadata at most twice; otherwise fail without changing the source. Native calls run in a dedicated worker, capture `errno` in that worker and keep descriptors open until it responds. Linux copies ACL xattrs after ownership/mode adjustments; Darwin uses metadata flags and verifies the result. Use `l*` APIs for symlink metadata without following the leaf. A copy may report unsupported attributes; move, trash and save require strict preservation. Do not persist attribute values into public job results.
- [ ] Extend release smoke to import Koffi from the **unpacked release**, read a harmless native property and exercise metadata copying in its disposable data directory. Keep Koffi optional platform packages in `npm ci --omit=dev` and in archives. Test initial release and update staging; if a required binary is missing, fail staging before switching the release pointer. This distribution supplies the helper without a new machine-level runtime installer.
- [ ] Run native suites and the affected release suites on macOS/Linux CI. Commit: `git commit -m "feat: preserve native file metadata across operations"`.

## Task 8: Journalisierte Veröffentlichung ohne Verlust des verdrängten Inhalts

**Files:** Create `server/features/files/{file-publish,file-recovery}.js`,
`tests/integration/file-publish.test.js`, `tests/integration/file-recovery.test.js`;
Modify `file-store.js`, `file-native.js`, `server/application/files.js`.

**Interfaces:** `FilePublisher({store,native,locks,barrier})` exposes
`stage(scope,target,{jobId,type="file",followLeaf=false}) → Promise<{id,file,name,type,handle,parentHandle,targetParentHandle,targetName,target,selectedPath,followLeaf,jobId}>`,
`publish(scope,stage,{expectedRevision,metadataSource=null}) → Promise<{path,revision,recoveryId:null|string}>`,
`discard(stage)`; `fileRevision(handle,linkIdentity=null) → Promise<string>` hashes
file identity and bounded/streamed bytes, returns the `d1:` variant and is shared
with Task 18. `assertExpected(scope,selectedPath,revision,{followLeaf,expectedTarget})`
dispatches `e1:` to `entryRevision` and `d1:` to `fileRevision`; it also verifies
that fresh resolution still identifies the staged target. For text writes only,
Task 18 sets `followLeaf:true`; copy/rename replacement acts on the selected link.
`recoverPublications({store,native})` reconciles journal phases; `recoveryId` refers
to displaced data still registered in `publications` until Task 9 adopts it.
Stages for files/directories own a corresponding descriptor; a link stage has
`handle:null` and is synced through its containing directory. The publisher keeps
all stage/parent handles open through the native call and closes them in `finally`.

- [ ] Write tests for new-target collision, external edit before publish, injected failure before/after exchange, double replay, unsupported exchange and recovery with an unrelated file placed at the original path.

```js
test("failed publication never truncates the destination", async (t) => {
  const f = await fileFixture(t);
  const target = path.join(f.home, "keep.txt");
  await fs.writeFile(target, "original");
  const store = new FileStore({ dataDir: f.dataDir });
  const jobId = seedFileJob(store, f.globalScope).id;
  const originalHandle = await fs.open(target, "r");
  const revision = await fileRevision(originalHandle);
  await originalHandle.close();
  const publisher = new FilePublisher({
    store,
    locks: new PathLocks(),
    barrier: new MutationBarrier(),
    native: {
      exchange: async () => {
        throw Error("injected");
      },
    },
  });
  t.after(() => store.close());
  const stage = await publisher.stage(f.globalScope, target, { jobId });
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  assert.equal(await fs.readFile(target, "utf8"), "original");
});
```

- [ ] Add `seedFileJob(store,scope)` to `tests/helpers/file-explorer.js`: return `store.request(scope,{requestId:Date.now()+":"+randomUUID(),kind:"copy",sources:[],target:scope.home,name:null,options:{}}).job`. Direct-service tests use its real stored ID, not a nonexistent foreign key. Run `node --test tests/integration/file-publish.test.js tests/integration/file-recovery.test.js` and confirm the regression is red.
- [ ] Create private `0700` stage directories next to targets, create files with `wx`/`0600`, and journal stage identity before work. Existing targets require a revision; absent targets use native no-replace rename. Flush complete data and strict metadata before publishing. For replacement, record intent, atomically exchange with the existing target, then record the displaced inode before moving it elsewhere.

```js
const { jobId, target } = stage;
if (stage.handle) await stage.handle.sync();
await store.putPublication({
  id: stage.id,
  jobId,
  phase: "prepared",
  target,
  staged: stage.file,
});
await locks.withPaths([target], async () => {
  await publisher.assertExpected(scope, stage.selectedPath, expectedRevision, {
    followLeaf: stage.followLeaf,
    expectedTarget: stage.target,
  });
  await barrier.run(async () => {
    await native.exchange(
      stage.parentHandle.fd,
      stage.name,
      stage.targetParentHandle.fd,
      stage.targetName,
    );
    await store.putPublication({
      id: stage.id,
      jobId,
      phase: "swapped",
      target,
      displaced: stage.file,
    });
  });
});
```

- [ ] Implement `publisher.assertExpected` with the declared revision variant and fresh resolved-target checks. Also inspect the displaced file and selected-link identity after exchange: if either differs, preserve both versions and report conflict; rollback only while the target still identifies the just-published inode. Never overwrite an unrelated post-exchange writer to restore the old state. Unsupported no-replace/exchange returns `FILE_WRITE_UNSUPPORTED` with retained source and staged data.
- [ ] Recovery only acts on matching recorded inode/parent identities. Expose ambiguous states as `FILE_INTERRUPTED` and preserve both copies. Parent directory sync completes durability where supported; failure is recorded, not mislabeled success. Reject removing filesystem root, project root in project mode, or storage ancestors through mutation helpers.
- [ ] Run both suites plus native tests; commit: `git commit -m "feat: journal atomic file publication and recovery"`.

## Task 9: Papierkorb, Wiederherstellung und endgültige Löschung

**Files:** Create `server/features/files/{file-trash,file-tree-transfer}.js`,
`tests/integration/file-trash.test.js`, `tests/integration/file-trash-recovery.test.js`,
`tests/blackbox/file-trash.test.js`; Modify handler registration, store/schema,
`server/http/routes/file-operations.js`, `server/features/operations/snapshot.js`,
`tests/integration/operations-restore-policy.test.js`, paired files catalogs.

**Interfaces:** `FileTrash({store,native,publisher,metadata,limits})` provides
`capture(scope,source,{jobId,reason}) → Promise<trashId>`,
`adoptDisplaced(scope,recoveryId) → Promise<trashId>`, `list(scope,cursor)`,
`restore(scope,trashId,target,{jobId,expectedRevision})`,
`purge(scope,trashId,{jobId,confirmation})`. Register `trash`, `restore`, `purge`
handlers. `reason` is `deleted` or `replaced`; emptying is a confirmed purge job
over a snapshot of selected IDs, not a recursive delete of the storage directory.
`copyVerified(scope,source,stage,{limits,signal,report,strictMetadata})` in
`file-tree-transfer.js` produces `{stage,manifest,assertSourceUnchanged,removeMatchingSource}`.
It copies regular files, directories and link entries; both returned methods are
async and operate only on recorded matching identities. The caller decides when
publication is complete and source removal is allowed.
For private trash storage, `FileTrash` constructs the same stage shape under its
server-owned payload directory after verifying that directory's ownership and
identity. The private sink is never accepted from a project request or returned as
a user-writable scope; the selected source still passes its original scope checks.

- [ ] Test same-filesystem rename, strict cross-filesystem copy, source revision change, permission/storage failure, restore conflict, interrupted adoption, link-only deletion and project filtering.

```js
test("trash failure leaves the source available", async (t) => {
  const f = await fileFixture(t);
  const source = path.join(f.home, "important.txt");
  await fs.writeFile(source, "keep");
  const store = new FileStore({ dataDir: f.dataDir });
  const jobId = seedFileJob(store, f.globalScope).id;
  const trash = new FileTrash({
    store,
    native: {
      renameNoReplace: async () => {
        throw Object.assign(Error(), { code: "ENOSPC" });
      },
    },
    limits: readFileLimits(),
  });
  t.after(() => store.close());
  await assert.rejects(
    trash.capture(f.globalScope, source, { jobId, reason: "deleted" }),
  );
  assert.equal(await fs.readFile(source, "utf8"), "keep");
});
```

- [ ] Run `node --test tests/integration/file-trash.test.js tests/integration/file-trash-recovery.test.js tests/blackbox/file-trash.test.js`.
- [ ] Store bytes in `<dataDir>/files/trash/<uuid>/payload`, metadata in `trash_entries`. Prefer native no-replace rename; EXDEV triggers bounded recursive copy, checksum/metadata verification and source revalidation before removal. Retain a per-entry journal for partially processed trees. Update `file-copy.js` in Task 11 to reuse this transfer primitive rather than introducing a second incompatible one.

```js
const id = randomUUID();
store.putTrash({ id, scopeId: scope.id, originalPath: source, phase: "copying", reason });
// After bytes, metadata and source identity have been verified:
store.putTrash({
  id,
  scopeId: scope.id,
  originalPath: source,
  phase: "recoverable",
  reason,
});
// Only the phase above permits removing the matching original source.
```

- [ ] Add explicit confirmation bound to selected trash IDs and current revisions for purge; no automatic expiry. Adoption of displaced data must remain visible even if its move into central trash fails. Restore checks both stored provenance and current project bounds, preserving data if its parent disappeared or is now a link outside scope. Symlink payloads remain links.
- [ ] Add explicit backup omissions for file trash, journals and transfer bytes; confirm ordinary and credential-enabled backup captures contain none of these bytes. Test recovery with unrelated files at old source/stage paths and reject any cleanup based solely on filename pattern.
- [ ] Run new suites and backup policy tests; commit: `git commit -m "feat: add recoverable file trash and restore"`.

## Task 10: Erstellen und Umbenennen mit konsistenten Konflikten

**Files:** Create `server/features/files/file-mutations.js`,
`tests/integration/file-mutations.test.js`, `tests/blackbox/file-mutations.test.js`;
Modify `file-job-handlers.js`, `server/application/files.js`, paired files catalogs.

**Interfaces:** `FileMutations({publisher,trash,locks,native})` provides handlers
`createFile`, `createDirectory`, `rename`, each accepting the Task-5 handler context.
Create options are `{}`; rename uses exactly one source and `name` in the same
parent directory. `expectedRevision` for a source is carried in
`options.revisions` keyed by source path. Cross-folder work uses `move` in Task 11.

- [ ] Test invalid names, Unicode, case-only rename, duplicate request IDs, readonly contexts and permission failures. Assert old target bytes survive every unresolved collision.

```js
test("creating an existing name becomes a conflict without modifying it", async (t) => {
  const f = await applicationFixture(t);
  await fs.writeFile(path.join(f.home, "keep.txt"), "keep");
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request("/api/files/operations", {
    method: "POST",
    headers: { "x-file-scope": context.scopeId },
    body: {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind: "create_file",
      sources: [],
      target: f.home,
      name: "keep.txt",
      options: {},
    },
  });
  const job = await waitForFileJob(f, (await response.json()).id, {
    states: ["waiting_for_conflict", "failed"],
  });
  assert.equal(job.status, "waiting_for_conflict");
  assert.equal(await fs.readFile(path.join(f.home, "keep.txt"), "utf8"), "keep");
});
```

- [ ] Run `node --test tests/integration/file-mutations.test.js tests/blackbox/file-mutations.test.js` before registering kinds.
- [ ] Create directories exclusively with `mkdir(...,{mode:0o700})`; create empty files through stage/publication. Use native no-replace for rename, including case-only rename via a journalled intermediate name on case-insensitive filesystems. Never overwrite a directory with a file. Record a resumable conflict object containing source and target revisions.

```js
await native.renameNoReplace(sourceParent.fd, sourceName, targetParent.fd, targetName);
// On EEXIST, leave both entries intact and suspend through the job context:
await conflict({
  type: "name",
  source: sourcePath,
  target: targetPath,
  sourceRevision,
  targetRevision,
  choices: ["replace", "skip", "keep_both", "cancel"],
});
```

- [ ] Let replace use publication plus `trash.adoptDisplaced`; preserving an old target is mandatory before reporting completion. Generated alternate names retain extensions, reserve atomically and respect the byte limit. Register the three handlers and server-side readOnly rejection; retain old session create-directory compatibility.
- [ ] Run both suites, `workspace-files.test.js` and catalog parity; commit: `git commit -m "feat: create and rename files with conflict checks"`.

## Task 11: Rekursives Kopieren, Verschieben und Konfliktfortsetzung

**Files:** Create `server/features/files/file-copy.js`,
`tests/integration/file-copy.test.js`, `tests/integration/file-move.test.js`,
`tests/integration/file-conflicts.test.js`; Modify `file-tree-transfer.js` from Task 9,
`file-jobs.js`, `file-job-handlers.js`, `server/http/routes/file-operations.js`.

**Interfaces:** `copyFiles(context)` and `moveFiles(context)` are handlers.
`FileJobs.resolve(scope,id,{conflictId,decision,applyToRemaining})` resumes only the
matching current conflict. `decision` is `replace`, `skip`, `keep_both`, `merge` or
`cancel`; allowed choices depend on both entry types. A wildcard replace decision
never applies to a directory/file type mismatch or a newly changed revision.

- [ ] Write multi-entry partial-failure, parent/child source de-duplication, own-descendant target, directory merge, link-copy, sparse-file budget and EXDEV tests. Explicitly race changes during the conflict dialog.

```js
test("a changed destination invalidates a previous replace decision", async (t) => {
  const f = await applicationFixture(t);
  const job = await startConflictingCopy(f);
  await fs.writeFile(path.join(f.home, "target", "same.txt"), "new external data");
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "x-file-scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision: "replace", applyToRemaining: false },
  });
  assert.equal(response.status, 409);
  assert.equal(
    await fs.readFile(path.join(f.home, "target", "same.txt"), "utf8"),
    "new external data",
  );
});
```

- [ ] Define local test helper `startConflictingCopy(f)` in this suite: make `source/same.txt` and `target/same.txt`, post a `copy` operation for the source file into target and wait for `waiting_for_conflict`. Run `node --test tests/integration/file-copy.test.js tests/integration/file-move.test.js tests/integration/file-conflicts.test.js`.
- [ ] Use `copyVerified` from Task 9 with an explicit iterative manifest; cap bytes/entries/depth while scanning **and** writing. Use opened file streams and progress counts; clone sparse extents where supported, otherwise count zero-filled streamed bytes against the cap. Copy links as links and record skipped special entries. Apply directory metadata after children are finished.

```js
const transferred = await copyVerified(scope, source, stage, {
  limits,
  signal,
  report,
  strictMetadata: operation.kind === "move",
});
await publisher.publish(scope, transferred.stage, { expectedRevision });
if (operation.kind === "move") {
  await transferred.assertSourceUnchanged();
  await transferred.removeMatchingSource();
}
```

- [ ] Implement `copyVerified`'s returned `assertSourceUnchanged()` and `removeMatchingSource()` as per-entry identity checks; source removal follows successful publication, not merely successful copying. Same-filesystem moves use native no-replace when no merge is required. Journal every completed entry so restart/retry does not repeat successful moves.
- [ ] Persist conflict suspension without holding path locks across human waiting. Re-acquire canonical overlapping locks and recheck both revisions on resume. Cancellation retains finished outputs and all unfinished sources; return `partially_completed` when appropriate.
- [ ] Run the three suites plus trash/recovery suites; commit: `git commit -m "feat: copy and move files with recoverable conflicts"`.

## Task 12: Mehrfachauswahl, Dateiaktionen und Papierkorb-Oberfläche

**Files:** Create `web/features/files/{FileActions,FileConflictDialog,TrashView}.jsx`,
`{useFileSelection,useFileClipboard}.js`, `file-actions.css`,
`tests/unit/file-selection.test.js`, `tests/browser/file-explorer-actions.spec.js`,
`tests/browser/file-explorer-trash.spec.js`; Modify `ExplorerWorkspace.jsx`,
`FileList.jsx`, `FileJobs.jsx`, paired files catalogs.

**Interfaces:** `useFileSelection(entries)` returns `{selected,anchor,select,range,toggle,clear}`;
`useFileClipboard()` returns `{items,action,copy,cut,clearCompleted}` and keeps
only scoped path/revision references in memory. `FileActions({scope,selection,client,jobs,onChanged})`
and `TrashView({scope,client,jobs,onChanged})` submit defined operations.

- [ ] Test contiguous Shift selection, toggles, stale selection after reload, failed-cut retention and modal dismissal. Browser tests use realistic job fixtures with per-entry success and failure.

```js
test("restore preserves a colliding original until a decision is made", async ({
  page,
}) => {
  await page.goto(baseURL + "/files?panel=trash");
  await page.getByRole("checkbox", { name: "Select report.txt" }).check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "File conflict" })).toBeVisible();
  await page.getByRole("button", { name: "Keep both", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Restored");
});
```

- [ ] Build and run `npx playwright test tests/browser/file-explorer-actions.spec.js tests/browser/file-explorer-trash.spec.js`; confirm controls are initially absent.
- [ ] Add visible action menus, context menus and selection checkboxes, create/rename dialogs, copy/cut/paste and path-copy. Scope clipboard operations again on the server. After partial cut, remove only successful source IDs from the clipboard.

```js
const requestId = `${Date.now()}:${crypto.randomUUID()}`;
await jobs.start({
  requestId,
  kind: "move",
  sources: clipboard.items.map((item) => item.path),
  target: folder,
  name: null,
  options: {
    revisions: Object.fromEntries(
      clipboard.items.map((item) => [item.path, item.revision]),
    ),
  },
});
```

- [ ] Make conflict choices type-aware, with an explicit apply-to-remaining checkbox. Implement default trash, restore, empty and permanent-delete confirmations bound to a frozen selection; show disk usage and reason `deleted`/`replaced`. Render interrupted adoption/recovery items with retained locations and recovery actions, never hide them as ordinary failures.
- [ ] Verify cancellation, errors and folder refresh; run both browser engines and `node --test tests/unit/file-selection.test.js tests/unit/i18n-catalogs.test.js`.
- [ ] Commit: `git commit -m "feat: add file actions and trash controls"`.

## Task 13: Streaming-Uploads und Einzeldatei-Downloads

**Files:** Create `server/features/files/{file-uploads,file-downloads}.js`,
`server/http/routes/file-transfers.js`, `tests/integration/file-uploads.test.js`,
`tests/blackbox/file-transfers.test.js`; Modify application composition, `server/app.js`,
handler registration and paired transfer catalogs.

**Interfaces:** `FileUploads({jobs,store,publisher,trash,limits})` exposes
`createGroup(scope,{requestId,path}) → {groupId,job}`,
`appendGroup(scope,id,{batchId,entries}) → counters`,
`commitGroup(scope,id) → FileJob`,
`create(scope,{requestId,path,name,bytes,groupId=null,entryId=null}) → {job,uploadId}`,
`receive(scope,id,readable,{signal,declaredBytes}) → Promise<FileJob>`, `sweep(now)`;
`downloadFile(scope,path,res,{signal,limits}) → Promise<void>` owns its opened descriptor.
`create` reserves a private staging target; it does not make the final name visible.
All methods validate the trusted scope against the stored job. Groups accumulate
their manifest in bounded batches, reject duplicate batch IDs with changed content
and validate aggregate bytes, entry count, depth and path aliases before commit.
`commitGroup` schedules required `create_directory` child operations internally.
File receiving starts only after its parent directory is ready; child uploads must
match their stored entry. Group counters also count actual received bytes and
exclude completed entries from explicit retries.

- [ ] Test a raw payload larger than the global 64-KiB JSON cap, byte-limit overflow, disconnect, full disk, duplicate upload request, source/destination change and headless/project authorization. Include a group whose individual files are each permitted but whose aggregate exceeds `jobBytes`: commit must fail before creating visible files. Download checks include bytes, no-store, MIME sniffing protection and filename quoting.

```js
test("upload bytes bypass the JSON parser and remain exact", async (t) => {
  const f = await applicationFixture(t);
  const scope = (await (await f.request("/api/files/context")).json()).scopeId;
  const bytes = Buffer.alloc(128 * 1024, 123);
  const created = await f.request("/api/files/uploads", {
    method: "POST",
    headers: { "x-file-scope": scope },
    body: {
      scopeId: scope,
      requestId: `${Date.now()}:${randomUUID()}`,
      path: f.home,
      name: "raw.bin",
      bytes: bytes.length,
    },
  });
  const { uploadId } = await created.json();
  const result = await fixtureFetch(`${f.url}/api/files/uploads/${uploadId}/content`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "x-file-scope": scope,
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.home, "raw.bin")), bytes);
});
```

- [ ] Run `node --test tests/integration/file-uploads.test.js tests/blackbox/file-transfers.test.js` and confirm red.
- [ ] Register narrowly matched stream routes after authentication/audit and **before** JSON parsing. Do not wrap the full receiving handler in `guardMutations`; jobs/publication still take their own short leases. `create` uses `jobs.reserve`, and `receive` uses `jobs.runReserved` to claim the transfer slot. Feed `req` through a bounded progress Transform into the registered staging file using `pipeline`; count bytes regardless of Content-Length and charge both child and parent group budgets transactionally.

```js
const counter = new Transform({
  transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > limit)
      return callback(fileProblem("FILE_LIMIT_EXCEEDED", 413, { limit }));
    report({ completedBytes: received });
    callback(null, chunk);
  },
});
await pipeline(req, counter, stage.handle.createWriteStream({ autoClose: false }), {
  signal,
});
```

- [ ] On complete bytes, flush, revalidate destination, publish and adopt displaced contents. On abort retain old targets and clean only registered incomplete data. Make the upload's completion idempotent after a lost response; retries of received bytes do not publish twice. Direct downloads validate a regular descriptor and stream it with attachment/no-store/nosniff headers; aborted clients close handles.
- [ ] Implement `uploads.sweep(now)` after startup recovery and hourly: remove only incomplete registered payloads inactive for 24 hours, with no active receiver or unresolved publication and matching stored identities. Completed download artifacts follow seven-day job retention. Test fake-clock expiry, identity mismatch and an active stream spanning the sweep; stop all timers on close.
- [ ] Test login expiry, wrong origin and bearer tokens for both normal and raw routes; commit: `git commit -m "feat: stream file uploads and downloads"`.

## Task 14: Upload-Auswahl, Ordner und Wiederholungen im Browser

**Files:** Create `web/features/files/{useFileUploads,file-upload-selection}.js`,
`FileUploads.jsx`, `file-transfers.css`,
`tests/unit/file-upload-selection.test.js`, `tests/browser/file-explorer-uploads.spec.js`;
Modify `ExplorerWorkspace.jsx`, `FileActions.jsx`, paired `file-transfers.js` catalogs.

**Interfaces:** `collectUploadSelection(input,{maxEntries,maxDepth}) → Promise<{files:[{file,relativePath}],directories:string[],omissions:string[]}>`;
`useFileUploads({client,folder,scopeId,jobs}) → {items,add,cancel,retry,busy}`.
The selection adapter supports FileList with `webkitRelativePath` and DataTransfer
directory entries. `submitUploadGroup(client,selection)` creates the group, appends
manifest batches below 60 KiB and commits it; it returns `{groupId,entries}` for the
hook to match local File references to server entry IDs. `FileUploads` renders the
bounded queue; file bytes stay in memory only through their browser File references.

- [ ] Test escaped/malformed relative paths, same-name files in different folders, empty-directory support and browser APIs that omit empty directories. Add upload progress, cancellation, login expiry and response-loss fixtures.

```js
test("retry keeps successful files and retries only the failed upload", async ({
  page,
}) => {
  await page.goto(baseURL + "/files");
  await page.getByLabel("Upload files").setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
  ]);
  await expect(page.getByText("first.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry second.txt" }).click();
  await expect(page.getByRole("status")).toContainText("Upload completed");
});
```

- [ ] Run `node --test tests/unit/file-upload-selection.test.js`, then build and run `file-explorer-uploads.spec.js` red.
- [ ] Use XHR for per-file upload progress, AbortController for cancellation and the existing login-required event. Never convert Explorer file bytes to data URLs. `submitUploadGroup` persists the manifest before starting child uploads; server-side group commit creates directories in parent-before-child order under the name-conflict contract. Send group/entry IDs when creating each upload so total bytes/entries/depth limits apply to the whole selection.

```js
xhr.open("PUT", `${client.base}/uploads/${encodeURIComponent(uploadId)}/content`);
xhr.setRequestHeader("Content-Type", "application/octet-stream");
xhr.setRequestHeader("X-File-Scope", scopeId);
xhr.upload.onprogress = (event) => updateProgress(itemId, event.loaded, event.total);
xhr.send(file);
```

- [ ] Define local `updateProgress(id,loaded,total)` in the hook; reconcile transport completion against job state before marking success. Maintain a maximum of three active transfers, preserve successful entries on retry and use a new request ID only for an explicitly new attempt. Show empty-directory omissions and require reselection after reload when File references are gone.
- [ ] In both browsers test native input fallback, external drop, folder structure, switching folders during a transfer, abort and partial success. Verify no file contents appear in localStorage/IndexedDB. Commit: `git commit -m "feat: add folder uploads and transfer recovery controls"`.

## Task 15: ZIP-Erstellung und ZIP-Downloads

**Files:** Create `server/features/files/{file-zip,file-archive-paths}.js`,
`tests/integration/file-zip.test.js`, `tests/blackbox/file-zip-download.test.js`;
Modify `package.json`, `package-lock.json`, `file-downloads.js`, handler registration,
`server/http/routes/file-transfers.js`, `THIRD_PARTY_NOTICES.md`.

**Interfaces:** `createZip(context)` handles `archive` with `options.output` equal
`file` or `download`; `archivePath(name)` validates relative ZIP names.
`downloadJobArtifact(scope,jobId,res,{signal})` opens only a completed job's recorded
artifact, never a caller-supplied scratch path. Artifact retention follows job
retention and never deletes a published archive in the user's target directory.

- [ ] Write round-trip archive tests with yauzl, duplicate root names, Unicode, empty directories, skipped links, missing/changing sources, byte overflow and cancellation. Test archive readiness before browser download.

```js
test("a ZIP download is unavailable until its artifact is complete", async (t) => {
  const f = await applicationFixture(t);
  const job = await startArchiveJob(f, { output: "download" });
  const pending = await f.request(`/api/files/jobs/${job.id}/download`);
  assert.equal(pending.status, 409);
  await waitForFileJob(f, job.id);
  const ready = await f.request(`/api/files/jobs/${job.id}/download`);
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get("content-disposition"), /^attachment;/);
});
```

- [ ] Define `startArchiveJob(f,{output})` locally: create fixture sources, post `archive` with a fresh scope header and request ID. Inject a handler barrier in this test so pending cannot finish before the 409 assertion. Run new suites red; install `npm install --save-exact yazl@3.3.1`.
- [ ] Traverse a bounded manifest without following links. Present the link-omission manifest as a conflict/confirmation before creating output. Validate missing sources up front and again per opened file. Feed checked readable streams lazily to yazl and persist progress; include empty directory entries.

```js
const zip = new yazl.ZipFile();
zip.addReadStreamLazy(
  "src/hello.txt",
  { mtime: new Date(0), mode: 0o100600 },
  (callback) => {
    openCheckedArchiveStream(scope, source, revision, signal).then(
      (stream) => callback(null, stream),
      callback,
    );
  },
);
zip.end({ forceZip64Format: true });
await pipeline(zip.outputStream, output, { signal });
```

- [ ] Implement `openCheckedArchiveStream(scope,path,revision,signal)` in `file-zip.js`: resolve/open regular descriptor, verify identity/revision, enforce running budgets and close on error/abort. ZIP64 covers the approved multi-GiB sizes. For `file`, use publisher/trash; for `download`, create a private completed artifact and return a job-bound URL. A missing source fails archive completion; no downloadable partial artifact remains.
- [ ] Run the two suites and normal transfer tests; commit: `git commit -m "feat: create ZIP archives and folder downloads"`.

## Task 16: Validiertes Entpacken mit begrenztem Arbeitsbereich

**Files:** Create `server/features/files/file-extract.js`,
`tests/integration/file-extract.test.js`, `tests/property/file-archive-paths.test.js`;
Modify `file-archive-paths.js`, handler registration, paired transfer catalogs.

**Interfaces:** `extractZip(context)` handles `extract`, one archive source and
`target` directory. `validateZipEntry(entry,{seen,limits}) → {relative,type,size}`
uses yauzl decoded names plus external attributes and encryption flags; `seen`
tracks normalized destinations, including file/parent conflicts.

- [ ] Generate malicious ZIPs in isolated fixtures: traversal, absolute POSIX/drive paths, backslash traversal, symlink, special mode, encrypted flag, file-parent collision, duplicate names and decompression overflow. Property tests vary path segments and separators.

```js
test("archive traversal is rejected before any target becomes visible", () => {
  const seen = new Set();
  assert.throws(
    () =>
      validateZipEntry(
        {
          fileName: "../escape.txt",
          uncompressedSize: 1,
          generalPurposeBitFlag: 0,
          externalFileAttributes: 0,
        },
        { seen, limits: readFileLimits() },
      ),
    { code: "FILE_ARCHIVE_PATH_INVALID" },
  );
});
```

- [ ] Run `node --test tests/integration/file-extract.test.js tests/property/file-archive-paths.test.js` and confirm red.
- [ ] Open yauzl with `lazyEntries:true`, `validateEntrySizes:true`, strict name handling and a bounded descriptor. Inspect all entry metadata before publishing any result. Reject encrypted and unsupported entry types; enforce actual uncompressed bytes during streaming, not just header values.

```js
yauzl.open(
  archivePath,
  { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
  (error, zip) => {
    if (error) return reject(fileProblem("FILE_ARCHIVE_INVALID", 400));
    zip.on("entry", (entry) => queueValidatedEntry(entry));
    zip.on("error", reject);
    zip.readEntry();
  },
);
```

- [ ] Define `queueValidatedEntry(entry)` in the handler: validate, write only under the private registered extraction stage, await bounded pipeline, then call `readEntry`. Reject symlinks and duplicate/case-folded aliases on the actual target filesystem before publishing. Apply conflicts through Task 11; keep partial publication explicit per entry. Extraction modes never introduce setuid/setgid or permissions beyond the chosen creation policy.
- [ ] Test target-parent link replacement during extraction and cancellation before/after the first publication; clean only the owned extraction stage. Run new tests and archive/copy suites; commit: `git commit -m "feat: safely extract ZIP archives through file jobs"`.

## Task 17: Archivaktionen und vollständige Vorgangsanzeige

**Files:** Create `web/features/files/FileArchiveDialog.jsx`,
`tests/browser/file-explorer-archives.spec.js`, `tests/browser/file-explorer-jobs.spec.js`;
Modify `FileActions.jsx`, `FileJobs.jsx`, `useFileJobs.js`, `file-api.js`, paired transfer catalogs.

**Interfaces:** `FileArchiveDialog({selection,folder,client,jobs,onClose})` posts
`archive`/`extract`; `FileJobs` pages through job entries and supports cancel/retry,
pending conflict and finished ZIP download. Retry reconstructs only failed entries
after revalidation and creates a new explicit request, preserving old evidence.

- [ ] Add fixtures for preparing a ZIP, omitted symlinks, extraction conflict, interrupted job after reload and more than one page of results.

```js
test("a completed folder archive exposes its job-bound download", async ({ page }) => {
  await page.goto(baseURL + "/files");
  await page.getByRole("checkbox", { name: "Select src" }).check();
  await page.getByRole("button", { name: "Download as ZIP" }).click();
  await expect(page.getByRole("status")).toContainText("Preparing archive");
  await expect(page.getByRole("link", { name: "Download archive" })).toHaveAttribute(
    "href",
    /\/jobs\/[^/]+\/download$/,
  );
});
```

- [ ] Build and run both new browser suites red.
- [ ] Add create ZIP, extract here/choose target and download selection actions. Show excluded links before starting; do not claim a ZIP contains everything after a partial operation. Use ordinary links for completed artifacts so the browser owns download progress.

```jsx
{
  job.status === "completed" && job.kind === "archive" && artifactReady && (
    <a href={`${client.base}/jobs/${encodeURIComponent(job.id)}/download`} download>
      {copy.downloadArchive}
    </a>
  );
}
```

- [ ] Define `artifactReady` from a server-projected completed-artifact boolean; add `artifactReady` to the archive job projection as an optional field. Render byte totals as unknown until known, partial results with both successes and errors, and restart states with explicit resume/retry choices. Opening a different folder must not lose running server jobs.
- [ ] Run both browser engines for the new suites and upload/actions regressions, plus catalog parity. Commit: `git commit -m "feat: expose archive actions and file job results"`.

## Task 18: Textvertrag, Revisionen und sicheres Speichern

**Files:** Create `server/features/files/file-text.js`,
`server/http/routes/file-text.js`, `web/features/files/file-text-format.js`,
`tests/integration/file-text.test.js`, `tests/blackbox/file-text.test.js`,
`tests/unit/file-text-format.test.js`; Modify application composition,
`server/app.js`, `file-api.js`, paired `file-editor.js` catalogs.

**Interfaces:** `FileText({publisher,trash,metadata,limits})` provides
`read(scope,path) → Promise<FileDocument>`,
`save(scope,path,bytes,{revision,requestId}) → Promise<{revision,path}>`.
`serializeDocument(document,text,{mixedLineEnding=null}={}) → Uint8Array` in the
browser restores BOM and LF/CRLF policy and rejects unchosen mixed-line conversion.
`fileRevision` is the Task-8 function, not a second metadata-only revision scheme.

- [ ] Write BOM, CRLF, trailing-newline, mixed-newline choice, invalid UTF-8, binary, hardlink and size-cap tests. Add two-writer, deleted-file and symlink-retarget tests against real files.

```js
test("saving a stale document preserves an agent's newer bytes", async (t) => {
  const f = await applicationFixture(t);
  const file = path.join(f.home, "note.txt");
  await fs.writeFile(file, "before");
  const context = await (await f.request("/api/files/context")).json();
  const doc = await (
    await f.request(`/api/files/text?path=${encodeURIComponent(file)}`)
  ).json();
  await fs.writeFile(file, "agent change");
  const response = await fixtureFetch(
    `${f.url}/api/files/text?path=${encodeURIComponent(file)}`,
    {
      method: "PUT",
      headers: {
        origin: f.url,
        "content-type": "text/plain;charset=utf-8",
        "if-match": JSON.stringify(doc.revision),
        "x-file-scope": context.scopeId,
        "x-file-request": `${Date.now()}:${randomUUID()}`,
      },
      body: "my draft",
    },
  );
  assert.equal(response.status, 409);
  assert.equal(await fs.readFile(file, "utf8"), "agent change");
});
```

- [ ] Run `node --test tests/unit/file-text-format.test.js tests/integration/file-text.test.js tests/blackbox/file-text.test.js` and confirm red.
- [ ] Read regular-file bytes under the text limit, decode UTF-8 fatally and return actual BOM/newline metadata. Hardlinked files and files that cannot use the required write/publish path report readOnly. Preserve distinct selected path and resolved target; the `d1:` revision includes the selected link identity when applicable. Keep the original selected path for `publisher.stage(...,{followLeaf:true})`, so final revision validation rechecks the link instead of losing its identity after canonicalization.

```js
export function serializeDocument(document, text, { mixedLineEnding = null } = {}) {
  const ending = document.lineEnding === "mixed" ? mixedLineEnding : document.lineEnding;
  if (!["lf", "crlf"].includes(ending))
    throw Object.assign(new Error("FILE_LINE_ENDING_REQUIRED"), {
      code: "FILE_LINE_ENDING_REQUIRED",
    });
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const body = ending === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized;
  return new TextEncoder().encode((document.bom ? "\uFEFF" : "") + body);
}
```

- [ ] Register PUT as a narrow raw/text route ahead of the global JSON parser. Require scope, one quoted revision in `If-Match` and request ID; reject wildcard/multiple If-Match values. Count body bytes rather than trusting declared length. Re-read current metadata, enforce OS write permission, stage complete replacement, copy strict metadata, publish and adopt displaced bytes. A lost response with identical request/body returns the recorded result, not another save. Stale revisions return a code only; the client explicitly fetches latest text for comparison.
- [ ] Preserve tabs' drafts on every error. Test failed metadata preservation, missing parent write permission and a third writer during conflict resolution. Run new suites and publication/trash regression tests; commit: `git commit -m "feat: save text files with revision conflict checks"`.

## Task 19: CodeMirror-Editor, Tabs und Sprachmodule

**Files:** Create `web/features/files/{FileEditor,FileEditorTabs}.jsx`,
`{file-editor-state,file-editor-languages,useFileEditor}.js`, `file-editor.css`,
`tests/unit/file-editor-state.test.js`, `tests/browser/file-explorer-editor.spec.js`;
Modify `ExplorerWorkspace.jsx`, `package.json`, `package-lock.json`,
`THIRD_PARTY_NOTICES.md`, paired editor catalogs.

**Interfaces:** `editorReducer(state,action)` owns tabs keyed by scope plus selected
path; each tab stores `{document,text,dirty,editorState,scrollTop}` in memory.
`useFileEditor({client,scopeId})` exposes `{tabs,activeId,open,activate,edit,save,close}`.
`FileEditor({tab,onChange,onSave})` mounts exactly one view for the active tab and
keeps the tab's EditorState on switches. `loadLanguage(filename) → Promise<Extension>`
returns empty extensions for unknown text languages.

- [ ] Test dirty calculation against the opened/saved baseline, tab identity in different scopes, cursor/undo retention and response order when switching files quickly. Add browser save, tabs and search/replace tests.

```js
test("switching tabs preserves an unsaved draft", async ({ page }) => {
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Open first.js" }).click();
  const editor = page.getByRole("textbox", { name: "File editor" });
  await editor.fill("const unsaved = true;\n");
  await page.getByRole("button", { name: "Open second.js" }).click();
  await page.getByRole("tab", { name: /first\.js/ }).click();
  await expect(editor).toContainText("const unsaved = true;");
  await expect(page.getByRole("tab", { name: /first\.js/ })).toContainText("•");
});
```

- [ ] Run reducer tests and build/browser test red. Install the pinned packages:

```sh
npm install --save-exact @codemirror/state@6.7.4 @codemirror/view@6.43.11 @codemirror/commands@6.11.0 @codemirror/search@6.7.2 @codemirror/language@6.12.4 @codemirror/merge@6.12.2 @codemirror/lang-javascript@6.2.5 @codemirror/lang-json@6.0.2 @codemirror/lang-html@6.4.12 @codemirror/lang-css@6.3.1 @codemirror/lang-markdown@6.5.2 @codemirror/lang-python@6.2.1 @codemirror/lang-yaml@6.1.3 @codemirror/legacy-modes@6.5.4
```

- [ ] Implement the reducer and a lazy-loaded editor with history, search, brackets, line numbers, syntax highlighting and save binding. Localize CodeMirror built-in phrases through `EditorState.phrases`; label the contenteditable element and disable browser spelling/capitalization for code.

```js
const state = EditorState.create({
  doc: tab.text,
  extensions: [
    history(),
    lineNumbers(),
    syntaxHighlighting(defaultHighlightStyle),
    keymap.of([
      {
        key: "Mod-s",
        run: () => {
          onSave();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    EditorView.contentAttributes.of({
      "aria-label": copy.editorLabel,
      spellcheck: "false",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString(), update.state);
    }),
  ],
});
```

- [ ] Map JS/JSX/TS/TSX, JSON, HTML, CSS, Markdown, Python, YAML to language packages; Shell/TOML use `StreamLanguage` and `legacy-modes`. Import language modules lazily and discard outdated loads when the tab changes. Plain text works without a language module. Keep Ctrl/Cmd+S and visible save available, with clear saving/saved/failed state.
- [ ] Test English built-in search text, read-only files, UTF-8/BOM/CRLF preservation and mobile viewport in both browsers; inspect Vite chunks to ensure the editor is absent from initial application code. Commit: `git commit -m "feat: add a tabbed file editor with syntax highlighting"`.

## Task 20: Entwurfsschutz, Konfliktvergleich und externe Aktualisierung

**Files:** Create `web/features/files/FileEditorConflict.jsx`,
`{useFileNavigationGuard,file-navigation-guard}.js`,
`tests/unit/file-navigation-guard.test.js`, `tests/browser/file-explorer-editor-conflicts.spec.js`,
`tests/browser/file-explorer-editor-navigation.spec.js`;
Modify `web/app/useWorkspaceNavigation.js`, `useFileEditor.js`, `FileEditorTabs.jsx`,
`FileEditor.jsx`, paired editor catalogs.

**Interfaces:** `registerFileNavigationGuard(guard) → unregister`,
`requestFileNavigation({next,reason,commit}) → Promise<boolean>` serializes pending
navigation decisions. `guard({next,reason})` resolves `true` only after a successful
save or explicit discard. `FileEditorConflict({draft,current,onUseCurrent,onSaveAs,onResolve})`
uses both explicit documents; it never overwrites draft state during loading.

- [ ] Test close-tab/save/discard/cancel, leaving via sidebar, browser back/forward, failed save during navigation and rapid repeated navigation. Add a real API conflict test in the browser using route responses for first and second revisions.

```js
test("cancelled navigation preserves the draft and current route", async ({ page }) => {
  await page.goto(baseURL + "/files?path=%2Fhome%2Ftest&file=%2Fhome%2Ftest%2Fa.js");
  await page.getByRole("textbox", { name: "File editor" }).fill("unsaved");
  const current = page.url();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(current);
  await expect(page.getByRole("textbox", { name: "File editor" })).toContainText(
    "unsaved",
  );
});
```

- [ ] Run unit test, build and both new browser suites red.
- [ ] Route in-app transitions through the guard before updating history or disposing editor state. Maintain an AgentPier navigation index in `history.state`; on guarded popstate, restore the previous index once, ask the guard and replay the intended delta once if accepted. Suppress only that own restoration/replay event, invalidate older pending decisions and preserve unrelated history.state fields. Test navigation without a recorded index as a separate case; replace the current location with the known previous route on cancel instead of adding repeated history entries.

```js
const navigate = async (next, replace = false) =>
  requestFileNavigation({
    next,
    reason: "application",
    commit: () => commitWorkspaceNavigation(next, replace),
  });
```

- [ ] Define `commitWorkspaceNavigation` within `useWorkspaceNavigation` from the existing push/replace/setRoute logic. Register native `beforeunload` only while dirty, and remove it when clean. Browser termination cannot guarantee recovery of in-memory drafts; internal navigation and tab switching must pass the explicit preservation tests.
- [ ] On 409 keep the draft and fetch the current file explicitly. Show CodeMirror's merge/diff view with use-current, manual resolution, save-as and explicit replace-at-current-revision. Another revision change returns to conflict. Clean tabs show a reload action after metadata revision changes; dirty tabs never auto-reload. Poll only active views, recheck on focus and cancel obsolete metadata reads.
- [ ] Run both browser engines, the unit suite and existing `navigation.spec.js`, `app-recovery.spec.js`; commit: `git commit -m "feat: protect file drafts and resolve external edits"`.

## Task 21: Tastatur, Touch und vollständige mobile Bedienung

**Files:** Create `web/features/files/useFileShortcuts.js`,
`tests/browser/file-explorer-accessibility.spec.js`;
Modify `ExplorerWorkspace.jsx`, `DirectoryTree.jsx`, `FileList.jsx`, `FileActions.jsx`,
`FileJobs.jsx`, `TrashView.jsx`, editor components and feature CSS/catalogs only as required.

**Interfaces:** `useFileShortcuts({selection,clipboard,actions,editorFocused})` scopes
shortcuts to the explorer region. File commands: Ctrl/Cmd+A, C, X, V, Delete, F2,
Escape and Enter. Editor keeps its own bindings; destructive actions still use
the same UI/job confirmation path as pointer input.

- [ ] Write keyboard-only journey, focus restoration, tree expansion, touch selection, contextual menu and 390×844/390×500 viewport regressions. Exercise the journey in English as well as German.

```js
test("file shortcuts do not intercept text editing", async ({ page }) => {
  await page.goto(baseURL + "/files");
  await page.getByRole("button", { name: "Open note.txt" }).click();
  const editor = page.getByRole("textbox", { name: "File editor" });
  await editor.fill("keep this");
  await editor.press("ControlOrMeta+a");
  await expect(page.getByRole("checkbox", { name: /Select / }).first()).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Move to trash" })).toBeDisabled();
});
```

- [ ] Build and run `npx playwright test tests/browser/file-explorer-accessibility.spec.js` red.
- [ ] Implement event scoping using focus containment; ignore shortcuts in input, textarea or contenteditable descendants. Do not listen globally to every paste event. Context menu has an equivalent visible button and Escape restores focus to the initiating row.

```js
const editable = event.target.closest("input, textarea, [contenteditable='true']");
if (editable || editorFocused || !explorerElement.contains(document.activeElement))
  return;
if (event.key === "Delete" && selection.size) {
  event.preventDefault();
  actions.trash();
}
```

- [ ] Keep the mobile tree in a drawer, active file in a main pane, editor tabs scrollable and job controls reachable above the soft keyboard. Label progress and live status, retain focus after mutation and avoid horizontal document overflow. Verify contrast/focus indicators using existing app styles.
- [ ] Run the accessibility suite and all `file-explorer-*.spec.js` suites on Chromium/WebKit after a build; save desktop/mobile screenshots to disposable evidence paths. Commit: `git commit -m "feat: complete keyboard and mobile file explorer flows"`.

## Task 22: Native Plattform- und Wiederanlauf-Abnahme

**Files:** Create `tests/helpers/file-platform.js`,
`tests/matrix/file-platform.test.js`, `tests/matrix/file-recovery-boundary.test.js`,
`tests/browser/file-explorer-live.spec.js`; Modify `.github/workflows/verify.yml`,
`tests/integration/release-package-output.test.js` and affected lifecycle tests.

**Interfaces:** `secondFileSystem(t) → {directory,dispose}` creates an isolated
second device; Linux uses a unique `/dev/shm` directory when its `stat.dev` differs,
macOS creates/mounts a uniquely named temporary disk image only in the explicitly
enabled platform suite. `AGENTPIER_FILE_FS_MATRIX=1` enables the extra native CI
coverage; all default fixtures still use their own homes, data stores and tmux socket.

- [ ] Add end-to-end native tests for ACL/xattr, uid/gid/mode preservation, EXDEV moves/trash/restore, ENOSPC, readonly mount behavior, same-size changes and recovery at every journal phase. Use independent OS tools to set/read fixture ACLs/xattrs so the test does not only compare the adapter against itself.

```js
test("cross-device trash preserves restorable content", async (t) => {
  const f = await applicationFixture(t);
  const second = await secondFileSystem(t);
  assert.notEqual((await fs.stat(f.dataDir)).dev, (await fs.stat(second.directory)).dev);
  const source = path.join(second.directory, "source.txt");
  await fs.writeFile(source, "cross-device", { mode: 0o640 });
  const job = await runFileOperation(f, { kind: "trash", sources: [source] });
  assert.equal(job.status, "completed");
  const { entries } = await (await f.request("/api/files/trash")).json();
  await runFileOperation(f, { kind: "restore", sources: [entries[0].id] });
  assert.equal(await fs.readFile(source, "utf8"), "cross-device");
  assert.equal((await fs.stat(source)).mode & 0o777, 0o640);
});
```

- [ ] Add `runFileOperation(f,{kind,sources=[],target=null,name=null,options={}})` to the test helper: get context, post with a new request ID and wait using `waitForFileJob`. Run the new matrix tests red for the unimplemented second-device fixture; then implement cleanup using the recorded mount identity. Never detach arbitrary devices or stop an unowned service.
- [ ] Enable the suite on one existing Node-24 backend job per OS. Linux CI installs test-only `acl` and `attr`; macOS uses system `chmod`/`xattr` and `hdiutil`. Ensure failed tests still detach their own image and remove the known temporary directory. Default local runs may explicitly skip a missing second device; required CI runs must fail if they cannot create their fixture.

```yaml
- name: Native file explorer filesystem matrix
  if: matrix.node == 24
  run: node --test tests/matrix/file-platform.test.js tests/matrix/file-recovery-boundary.test.js
  env:
    AGENTPIER_FILE_FS_MATRIX: "1"
```

- [ ] Add a browser live suite against an isolated `applicationFixture`, without API mocking: create folder/file, upload bytes, download and compare, edit/save, inject external edit, resolve, trash and restore. In this Playwright suite pass `{after:fn => cleanups.push(fn)}` as the application fixture's cleanup registrar; close its browser context and run registered callbacks in `finally`. Use the fixture's cookie via `browser.newContext`/`addCookies` and keep the configured shared browser test server untouched.
- [ ] Verify unpacked release metadata/rename operations and update compatibility on all published OS/architecture targets. Record which combinations actually ran; never claim a matrix passes merely because it exists. Commit: `git commit -m "test: verify file explorer recovery across platforms"`.

## Task 23: Betrieb, Gesamtprüfung und Integrationsabschluss

**Files:** Create `docs/file-explorer.md`; Modify `docs/architecture.md`,
`docs/installation.md`, `docs/linux.md`, `THIRD_PARTY_NOTICES.md` and tests only for
newly discovered integration defects. Remove completed files under
`docs/superpowers/specs/` and `docs/superpowers/plans/` as the final cleanup change.

**Interfaces:** The delivered behavior is the approved spec plus the defined HTTP
contracts. Durable docs explain effective OS rights, project scope, hidden files,
links, metadata limitations, conflict recovery, host limits, job retention, upload
reselection and trash exclusion from application backups.

- [ ] Run the complete repository checks and both browser engines from an isolated implementation worktree:

```sh
npm run check
AGENTPIER_TEST_BROWSER=chromium npm run test:e2e
AGENTPIER_TEST_BROWSER=webkit npm run test:e2e
```

- [ ] Resolve actual failures with targeted regressions. Confirm catalog parity,
      changed UI in English, native release smoke, cross-filesystem CI and the live
      browser journey. Record command, result, OS/browser and evidence paths; do not
      replace real validation with the illustrative snippets in this plan.
- [ ] Write the operating guide with a concrete recovery example: after an
      interrupted replacement, keep the displayed versions, inspect them and explicitly
      restore the desired copy. Document retained-copy locations without putting real
      user paths/content into examples. Add package notices for all new dependencies.

```markdown
### Interrupted file operations

Open Files → Operations to inspect finished and unfinished entries. A cancelled
multi-file operation keeps its completed results. Restore deleted or replaced
files from Files → Trash; failed trash operations retain their original source.
```

- [ ] Review spec-to-task coverage below, then remove only this feature's completed
      temporary spec/plan documents. Keep lasting API/architecture choices in
      `docs/file-explorer.md` or `docs/architecture.md`. Run formatting and `git diff --check`
      after cleanup; commit: `git commit -m "docs: document file explorer operations and recovery"`.
- [ ] Request code review using the applicable review skill. Prepare a PR describing
      the previous session-only preview and the resulting owner-scoped file manager,
      validation and desktop/mobile screenshots. Link actual issues only if assigned;
      do not invent issue IDs. Use a body file for multiline text, for example:

```sh
gh pr create --title "feat: add a full file explorer with recoverable operations" --body-file /tmp/agentpier-file-explorer-pr.md
```

- [ ] Respect branch protection. Merge only when required checks pass, all review
      conversations are resolved and merging is authorized for the execution session.
      After a successful merge, remove only clean, inactive worktrees with
      `git worktree remove`; preserve any active sessions, uncommitted data or unmerged work.

## Abhängigkeiten und Abdeckung der Spezifikation

| Task | Erforderliche Vorgänger                    |
| ---- | ------------------------------------------ |
| 1    | Geprüfter Implementierungs-Ausgangszustand |
| 2    | 1                                          |
| 3    | 1, 2                                       |
| 4    | 3                                          |
| 5    | 1, 3                                       |
| 6    | 4, 5                                       |
| 7    | 1                                          |
| 8    | 5, 7                                       |
| 9    | 8                                          |
| 10   | 8, 9                                       |
| 11   | 9, 10                                      |
| 12   | 4, 6, 9, 10, 11                            |
| 13   | 8, 9, 10                                   |
| 14   | 12, 13                                     |
| 15   | 8, 9, 11, 13                               |
| 16   | 11, 15                                     |
| 17   | 12, 14, 15, 16                             |
| 18   | 8, 9, 13                                   |
| 19   | 4, 18                                      |
| 20   | 19                                         |
| 21   | 12, 14, 17, 20                             |
| 22   | 7–21                                       |
| 23   | 22                                         |

Diese Abhängigkeiten erlauben technische Vorbereitung, sind keine Aufforderung,
ohne gewählten Ausführungsmodus zusätzliche Agenten zu starten.

| Spezifikationsbereich                                             | Umsetzung und Nachweis                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1–2: Globaler Zugriff, gemeinsames Modul, alte Sitzungen          | 1–4, 21, 22                                                                           |
| 3: Baum, Liste, Eigenschaften, Favoriten, Suche, URLs             | 2–6, 21                                                                               |
| 4: Mutationen, Namenskonflikte, Rechte, Mehrfachvorgänge          | 7–12, 22                                                                              |
| 5: Dateien/Ordner übertragen, ZIP, Abbruch und Wiederholung       | 13–17, 22                                                                             |
| 6: Text/Bilder, Tabs, Sprachen, Kodierung und Revisionen          | 2, 18–20, 22                                                                          |
| 7: Papierkorb, Ersetzen, Restore, Purge, Speicherfehler           | 8–12, 22, 23                                                                          |
| 8: Anmeldung, Origin, Token-Sperre, Link-/Hardlink-/Sonderdateien | 1–3, 7–11, 13, 16, 18, 22                                                             |
| 9: Komponenten, HTTP, Dauerhaftigkeit, Sperren, Shutdown          | 3, 5, 7–9, 13, 18, 20, 22                                                             |
| 10: Grenzen, Streaming, Bereinigung, Installation/Update          | 1–2, 5–9, 13–16, 22–23                                                                |
| 11: Plattformen, Browser, Übersetzungen, CI und Cleanup           | Jeder UI-Task, 21–23                                                                  |
| 12: Bewusste Grenzen                                              | Keine Tasks für SFTP, Cloud, IDE, Volltextindex oder automatische Entwurfsspeicherung |

## Übergabe

Dieser Plan beschreibt die Umsetzung; er erteilt keine zusätzliche Freigabe zum
Veröffentlichen oder Deployen. Nach Übergabe kann die Umsetzung entweder mit
`superpowers:subagent-driven-development` und Review pro Task oder mit
`superpowers:executing-plans` in derselben Sitzung erfolgen. Der Nutzer wählt den
Ausführungsmodus; bis dahin bleiben die Checkboxen offen.

## Execution contract corrections — 2026-09-13

These rulings reconcile the plan with the approved spec; all 23 tasks and approved features remain required. Preflight findings and the execution ledger retain the supporting plan/spec references.

Ruling: F1 — Include necessary catalog, helper, lifecycle and projection edits in the task that introduces their behavior. Every new FILE_* error receives paired German/English reactive catalog mappings in the same commit; T5 owns shutdown integration, T6/T8/T22 own fixture helper extensions, T17 owns artifactReady projection — the spec requires working integrated behavior and same-commit translations — cost if wrong: slightly larger reviewed task diffs.

Ruling: F2 — FileJobs.start and reserve return Promise<FileJob>; all callers await durable registration under a short MutationBarrier lease. Propagate async reservation through uploads and HTTP adapters; test registration while a snapshot holds its lease — the existing barrier is asynchronous — cost if wrong: signature propagation rework.

Ruling: F3 — T5 implements generic durable conflict/cancel/resolve transport. Handlers must leave path-lock and global-barrier leases before waiting for a human and explicitly reacquire and revalidate before acting; T9/T10 supply type/revision validation, T11 adds multi-entry/apply-to-remaining behavior — early restore/create/rename tasks must be usable — cost if wrong: some generic conflict implementation moves between tasks.

Ruling: F4 — Archive omission conflicts accept skip_links or cancel, bound to conflictId plus the reviewed bounded omission-manifest version. New or changed omissions require new consent. T11 permits typed choices; T15 owns archive validation and T17 its UI — the spec explicitly requires omission consent — cost if wrong: one resolver/UI state needs revision.

Ruling: F5 — Extend PUT /text with an explicit creation mode requiring If-None-Match: * and atomic no-replace. Ordinary save still requires one quoted d1 If-Match revision and never recreates a missing original; mutually exclusive preconditions are enforced. Save As onto an existing regular editable target requires its freshly read d1 and explicit replacement consent. T18 owns this transport, T19 exposes saveAs and T20 wires readonly/conflict actions, retaining the original draft until confirmed completion — Save As is required for hardlinks, readonly files and vanished originals — cost if wrong: a small text API/editor extension needs rework.

Ruling: F6 — FileDocument and save results additionally carry metadataRevision (e1), captured consistently with the opened/saved document; tabs store it separately from their d1 revision. Polling compares e1 only with e1; saving uses d1 only. Test unchanged tabs and same-size external edits — content and metadata revisions represent different observations — cost if wrong: one response/tab field needs migration.

Ruling: F7 — T12 implements internal drag-and-drop move with the actual destination shown before submission, using scoped file references; T14 distinguishes external upload drops and T21 verifies keyboard/touch alternatives and focus — internal moves are explicitly approved — cost if wrong: localized UI/test rework.

Ruling: F8 — Strengthen illustrative test oracles while retaining every named behavior: actual growth during reads; no-follow sentinel independently of truncation; exact injected failure and call observation; per-file retry counts; real extraction target visibility; actual editor selection; handler-entry synchronization before job close. T22 retains independent OS metadata observations — examples alone do not prove their stated guarantees — cost if wrong: test fixture complexity, not product scope.

Ruling: F9 — Upload progress persistence must be awaited or bounded/coalesced, propagate failures through the stream callback, and flush final counters before completion. Test a slow and failing reporter — discarded report promises defeat backpressure and durability — cost if wrong: localized stream implementation rework.

Ruling: F10 — Explorer route parsing preserves an explicit invalid-page state. Listing UI owns snapshots across pagination, displays localized expiry with an explicit refresh action, and resets page/snapshot together on refresh or a changed non-page query; no silent page substitution — the spec requires truthful pages and 30-second snapshot expiry — cost if wrong: route/hook state rework.

Ruling: F11 — T23 may make minimal source fixes demonstrated by failing integration checks, with regression coverage and normal review, before removing only this feature's completed temporary plan/spec — full completion requires fixing actual integration failures — cost if wrong: modest final reviewed source diff.

Integration decision: retain existing PR79 branch and integrate current main using ordinary merges. Preserve SessionViewMemory navigation, local-only remote links, Modal style support, credential commitIdentity, current dependency/version changes and installation/update guidance (D1–D5). Existing unrelated session-view preferences may remain in sessionStorage; file drafts stay in RAM.

## Additional implementation rulings

Ruling: T2 snapshot capacity — Unused means not held by an in-flight listing/build. Keep at most eight slots across this owner, pin active requests/builds, expire at TTL and evict the least-recently-used inactive completed snapshot when needed. Reject new creation only if all slots are actively in use; evicted IDs return the same explicit 409 as expired IDs — no browser lease/release API exists, and ordinary navigation must not be limited to eight directory clicks per 30 seconds — cost if wrong: cache eviction policy and tests need revision.

Ruling: T2 read prerequisite — Bring forward the read-only native descriptor foundation and its Koffi distribution checks from Task7. Traverse validated canonical paths relative to opened directory handles with no-follow component opens, and read only the resulting owned regular descriptor; pathname-stat comparisons alone do not establish descriptor provenance. Keep Task7 metadata/rename APIs and their complete acceptance work for Task7 — review fix1 demonstrated that separate metadata and path observations remain insufficient — cost if wrong: a small native foundation may need refactoring when Task7 extends it.

Ruling: Native release-test runtime — Detect a copied-runtime shared-library loader failure before native smoke, and explicitly skip that relocation-only fixture outside CI when the host Node cannot relocate. CI must fail rather than skip; actual Koffi/node-pty or release-smoke failures never qualify. Keep the successful official Node22 full-suite and real release-build evidence — a valid locally installed Homebrew Node may depend on its installation path, while production release construction uses an official portable runtime — cost if wrong: a local packaging regression could escape the narrow fixture, with mandatory official-runtime CI remaining the gate.
