# REA as a Managed Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AgentPier installs REA (`rea-agents`) with selectable components (Core, Ghidra + Temurin JDK, Frida, bring-your-own tools), registers it as a managed MCP server, keeps it current and removes it on request — no shell work.

**Architecture:** Ghidra and the JDK are pinned, SHA-256-checked archives unpacked below `<data>/clis/.packages/<id>-<uuid>` behind atomically switched links (`<data>/clis/rea-ghidra`, `<data>/clis/rea-jdk`), like the managed browser. Core is a packaged MCP server row (`server_packages`) installed by the existing McpPackages job from a lockfile committed to AgentPier, with `--ignore-scripts`; an `afterInstall` hook places Frida's checksummed prebuild before the install is committed. A new `managed_servers` table marks the row (origin `managed`), locks its command and managed environment keys, and a `ReaTool` service orchestrates install, component changes, updates at server start, skill copies and uninstall.

**Tech Stack:** Node.js ES modules, `node:sqlite` (via `privateDatabase`), `node:zlib` streaming gunzip, `yauzl` (zip), Express routes, React + existing UI primitives, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-rea-managed-tool-design.md` (owner-approved, incl. binding spike pins). Read it with this plan; the plan never overrides a decision there.

## Global Constraints

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`; platforms macOS and Linux only.
- Pins (spike 2026-10-27, binding): Ghidra **12.1.4** (JDK 21), Temurin **21.0.13+9**, rea-agents **6.8.0**, frida **17.23.2** (N-API prebuild `napi-v8`).
- Ghidra darwin-arm64: Homebrew bottle from ghcr.io, `arm64_sequoia` sha256 `fdaf330d5d9e3a2ad7c58c4cf69c6a145ec8a964c119617d6476f911434d6ca2`, 464278484 B; `arm64_tahoe` sha256 `d2a6222389d18d32d48e55079407c1d877d90f86d692911b0399a6ff5e440a9a`, 464260893 B; pick by macOS version, newer macOS falls back to tahoe. `GHIDRA_INSTALL_DIR` = the bottle's `libexec`; Homebrew launcher scripts are never used; `brew` is never run.
- Ghidra linux-x64: the official Ghidra 12.1.4 zip (ships `linux_x86_64` natives), never the Homebrew Linux bottle. linux-arm64 and darwin-x64: Ghidra unavailable with a clear reason.
- Temurin darwin-arm64: `OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz`, sha256 `bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a`, 199754598 B. frida darwin-arm64 prebuild: sha256 `850fba220a2d9b6aae282ac6dde37f48847e73597b7a06d648737ff9addc3340`, 38219481 B, single file `build/frida_binding.node`.
- Every other pin (Ghidra linux zip, Temurin linux-x64, frida linux-x64/linux-arm64/darwin-x64, rea-agents integrity) is verified upstream on the day it is pinned; the manifest comment records the date.
- Never run `rea setup`, frida's install script, any remote install script, or `brew`. Core installs with `--ignore-scripts` from the committed lockfile.
- Never download Hopper, IDA or JEB. No pwntools/Python helper. No nono sandbox support for REA (shown clearly instead). No generic "tool bundle" framework.
- REA starts with a controlled environment: own HOME/TMPDIR (and XDG dirs), no inherited CLI config directory; `REA_MCP_INPUT_SCHEMA_PROFILE=compact`.
- Source and test files stay at or below 600 lines (`npm run check:structure`). Near the limit already: `server/features/mcp-servers/mcp-server-store.js` (585), `server/features/mcp-packages/mcp-packages.js` (567), `server/features/tools/tool-installer.js` (538) — each gets at most a few lines; REA logic lives in new modules.
- All new UI copy in German and English with matching keys; `npm run i18n:confirm` and the updated `translation-lock.json` files committed. Server messages go in `server/lib/i18n/de/*` and `server/lib/i18n/en/*`.
- UI only from `docs/ui-guide.md` components and tokens: no new hex colours, no font size below 11px, no new breakpoints, no bespoke dialogs/menus/switches.
- Tests: `node:test` + strict asserts; Playwright for the browser. No real downloads in any test — local HTTP servers and fixture archives only. Never the default tmux server.
- Commits: English, prefixes `feat:`/`fix:`/`chore:`, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Name collision with an owner's own REA row** — the owner already added `rea` from the directory: the managed row is created as `rea-agentpier`, the owner's row is never touched, renamed or bound differently. Test in Task 8.
2. **Uninstall or component change while a CLI session that binds REA is still running in tmux after an AgentPier restart** — refused with the in-use reason; the server-start update skips and retries next start instead of pulling files from under the session. Test in Task 8.
3. **A bottle or JDK archive whose real layout deviates from the fixture** (PAX long names, hard links, links inside the app bundle) — unpacks, or fails with an archive message, never writes outside the version directory. Tests in Task 1 (PAX/GNU long names, hard link, link chains).
4. **Interrupted install (crash, shutdown, disk full mid-Ghidra)** — no half-published component: the link still points at the previous version or does not exist; leftovers are swept at the next start; disk-full has its own message. Tests in Task 4.
5. **Owner edits the managed row through the normal MCP pages** (rename, change args, delete a managed env key, delete the row, package update/reinstall) — refused with 409 and a message that points to the REA card, while adding own env keys and binding CLIs/agents keep working and survive component changes. Tests in Task 5 and Task 8.

---

### Task 1: Shared archive safety and a streaming tar.gz unpacker

**Files:**

- Create: `server/features/tools/archive-safety.js`
- Create: `server/features/tools/zip-unpack.js`
- Create: `server/features/tools/tar-unpack.js`
- Modify: `server/features/tools/chromium-installer.js:131-298` (move `entryName`, `realParents`, the link checks and the yauzl loop out; keep `unpackChromium` as a thin wrapper)
- Modify: `server/lib/i18n/de/tools.js`, `server/lib/i18n/en/tools.js` (add `archiveInvalid`)
- Create: `tests/helpers/tar-fixture.js`
- Test: `tests/unit/tar-unpack.test.js`; existing `tests/integration/managed-chromium.test.js` stays green unchanged

**Interfaces:**

- Produces:
  - `archive-safety.js`: `entryName(name: string, top: string): string`, `realParents(dest: string, relative: string): Promise<void>`, `checkLink(relative: string, link: string, top: string): void`, `assertLinksInside(dest: string, top: string, links: string[]): void`, `entryMode(mode: number): 0o755|0o644`. All throw `problem(message, 409)` with the existing `serverMessages.tools.*` texts (`unsafeArchivePath`, `archiveSizeExceeded`, `duplicateArchivePaths`, `specialArchiveFilesForbidden`, `encryptedArchivesForbidden`).
  - `zip-unpack.js`: `unpackZip(file: string, dest: string, top: string, signal?: AbortSignal, limits?: { maxExpanded: number, maxFiles: number, invalid: string }): Promise<void>`
  - `tar-unpack.js`: `unpackTarGz(file: string, dest: string, top: string, signal?: AbortSignal, limits?: { maxExpanded: number, maxFiles: number }): Promise<void>`
  - `tests/helpers/tar-fixture.js`: `tarGz(entries: Array<{ name: string, type?: "file"|"dir"|"symlink"|"hardlink"|"char", content?: string|Buffer, mode?: number, link?: string, pax?: boolean, gnuLong?: boolean }>): Buffer` — writes raw ustar headers (with optional PAX `x` / GNU `L`/`K` records) so tests can build hostile archives system `tar` refuses to create.

- [ ] **Step 1: Write the failing tests** in `tests/unit/tar-unpack.test.js`, each unpacking a `tarGz(...)` fixture written to a temp file into a fresh temp `dest` with `top = "pkg"`:

```js
test("unpacks files, folders, relative links and modes inside the top folder", ...)
  // pkg/bin/tool (0o4755 → stored 0o755, setuid gone), pkg/lib/a.txt (0o644),
  // pkg/current -> lib (symlink): assert contents, modes, readlink === "lib"
test("PAX and GNU long names over 100 bytes unpack under their full name", ...)
test("a hard link becomes a copy of a file unpacked earlier inside the top folder", ...)
test("refuses ../, absolute names, names outside the top folder and backslashes", ...)
  // each: await assert.rejects(unpackTarGz(...), { message: serverMessages.tools.unsafeArchivePath })
test("refuses a link that leaves the top folder, directly or through a chain", ...)
test("refuses a hard link to a path not unpacked before or outside the top folder", ...)
test("refuses device files", ...)        // specialArchiveFilesForbidden
test("refuses names that differ only in case", ...) // duplicateArchivePaths
test("stops at the expanded size and file count limits", ...) // archiveSizeExceeded
test("a truncated or non-gzip archive fails with archiveInvalid", ...)
test("an aborted signal stops unpacking", ...) // installationAbortedOrTimedOut
test("nothing is written outside dest for any refused archive", ...) // walk tmp parent
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/tar-unpack.test.js`
Expected: FAIL — `Cannot find module .../tar-unpack.js`

- [ ] **Step 3: Implement**
  - Move the zip safety code from `chromium-installer.js` into `archive-safety.js` and `zip-unpack.js` without behaviour change; `chromium-installer.js` keeps `export const unpackChromium = (file, dest, top, signal) => unpackZip(file, dest, top, signal, { maxExpanded: MAX_EXPANDED, maxFiles: MAX_FILES, invalid: serverMessages.tools.chromiumArchiveInvalid })`.
  - `unpackTarGz`: stream `fs.createReadStream(file)` → `zlib.createGunzip()` → a 512-byte block parser; no full-archive buffer. Supported types: `0`/`\0` file, `5` dir, `2` symlink, `1` hard link (copy of an already-unpacked regular file below `dest/top`, via `fsp.copyFile` with `COPYFILE_EXCL`), `x` PAX (`path`, `linkpath`, `size`), `g` ignored, GNU `L`/`K`. Anything else → `specialArchiveFilesForbidden`. Header checksum mismatch, short read or gunzip error → `tools.archiveInvalid`. Default limits: `maxExpanded` 2 GiB, `maxFiles` 30000 (Ghidra has ~5200 files, the JDK ~460). Files written with `flags: "wx"` and `entryMode`. After the end, `assertLinksInside`.
  - Add `tools.archiveInvalid` (de: "Das Archiv ist beschädigt oder hat ein unbekanntes Format.", en: "The archive is damaged or has an unknown format.").

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/tar-unpack.test.js tests/integration/managed-chromium.test.js`
Expected: PASS

- [ ] **Step 5: Confirm the new key and commit**

```bash
npm run i18n:confirm -- tools
git add server/features/tools/archive-safety.js server/features/tools/zip-unpack.js server/features/tools/tar-unpack.js server/features/tools/chromium-installer.js server/lib/i18n tests/helpers/tar-fixture.js tests/unit/tar-unpack.test.js
git commit -m "feat: unpack tar.gz archives with the browser installer's safety checks"
```

---

### Task 2: Verified download with redirects, host allowlist and ghcr.io token

**Files:**

- Create: `server/features/tools/verified-download.js`
- Create: `server/lib/i18n/de/rea.js`, `server/lib/i18n/en/rea.js`; register in `server/lib/i18n/catalog-de.js` / `catalog-en.js` as `rea`
- Test: `tests/unit/verified-download.test.js`

**Interfaces:**

- Produces: `verifiedDownload({ entry: { url: string, sha256: string, size: number, auth?: "ghcr-anonymous" }, file: string, allow: Record<string, string[] | null>, fetchImpl: typeof fetch, signal?: AbortSignal, progress?: (percent: number) => void }): Promise<void>` — streams to `file` (`flags: "wx"`, mode 0o600); throws `problem(serverMessages.rea.downloadFailed|checksumMismatch|forbiddenRedirect|redirectLimit, 409)`, `tools.downloadHttpFailed(status)`, `tools.installationAbortedOrTimedOut`; lets `ENOSPC` through.
- Produces: `reaSources` constant (exported from `verified-download.js`):
  `{ "ghcr.io": ["/v2/homebrew/core/ghidra/blobs/"], "pkg-containers.githubusercontent.com": null, "github.com": ["/NationalSecurityAgency/ghidra/releases/download/", "/adoptium/temurin21-binaries/releases/download/", "/frida/frida/releases/download/"], "release-assets.githubusercontent.com": null, "objects.githubusercontent.com": null }` (`null` = any path on that host).

- [ ] **Step 1: Write the failing tests** (local `http.createServer`; `fetchImpl` maps the https URL's host+path to the local server and records request headers):

```js
test("streams a matching download and reports whole percents", ...)
test("follows up to three redirects, each checked against the allowlist", ...)
test("refuses a redirect to a host or path outside the allowlist", ...) // forbiddenRedirect
test("refuses http:, credentials, ports and a fourth redirect", ...)
test("sends 'Authorization: Bearer QQ==' only to ghcr.io, never after a redirect", ...)
test("refuses a wrong content-length, an oversize body and a wrong SHA-256", ...) // checksumMismatch
test("a non-2xx answer names the status", ...) // downloadHttpFailed(404)
test("an abort stops the download and leaves no partial file behind", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/verified-download.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** by combining `chromium-installer.js` `download()` (streaming hash, content-length and size checks, progress) with `github-mcp-installer.js` `download()` (`redirect: "manual"`, ≤3 redirects, `releaseURL` check). `credentials: "omit"`, `User-Agent: AgentPier`; the bearer header is set only when `entry.auth === "ghcr-anonymous"` and the current URL's host is `ghcr.io`. On any failure the partial `file` is removed. Server copy in the new `rea` catalog: `downloadFailed`, `checksumMismatch`, `forbiddenRedirect`, `redirectLimit` (de + en).

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/verified-download.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/tools/verified-download.js server/lib/i18n tests/unit/verified-download.test.js
git commit -m "feat: download pinned archives through checked redirects"
```

---

### Task 3: REA manifest, platform selection and the committed Core lockfile

**Files:**

- Create: `server/features/tools/rea-manifest.js`
- Create: `server/features/tools/rea-package-lock.json` (generated, committed)
- Create: `scripts/refresh-rea-lock.mjs`
- Modify: `.prettierignore` (add `server/features/tools/rea-package-lock.json`)
- Modify: `server/lib/i18n/{de,en}/rea.js` (platform reasons)
- Test: `tests/unit/rea-manifest.test.js`

**Interfaces:**

- Produces `reaManifest` with this shape (sizes in bytes; `installedSize` from the spike, KiB × 1024):

```js
{
  checked: "2026-10-27",
  core: { name: "rea-agents", version: "6.8.0", integrity: "sha512-…", program: { name: "rea", path: "scripts/rea.mjs" },
          args: ["mcp"], downloadSize: 86032384, installedSize: 171048960 },
  ghidra: { version: "12.1.4", platforms: {
    "darwin-arm64": { kind: "tar.gz", top: "ghidra", installDir: "ghidra/12.1.4/libexec",
      decompiler: "Ghidra/Features/Decompiler/os/mac_arm_64/decompile", installedSize: 804155392,
      variants: [ { name: "arm64_sequoia", minDarwin: 24, url: "https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:fdaf…6ca2", sha256: "fdaf…6ca2", size: 464278484, auth: "ghcr-anonymous" },
                  { name: "arm64_tahoe",   minDarwin: 25, url: "…sha256:d2a6…0a9a", sha256: "d2a6…0a9a", size: 464260893, auth: "ghcr-anonymous" } ] },
    "linux-x64": { kind: "zip", top: "ghidra_12.1.4_PUBLIC", installDir: "ghidra_12.1.4_PUBLIC",
      decompiler: "Ghidra/Features/Decompiler/os/linux_x86_64/decompile", url, sha256, size, installedSize } } },
  jdk: { version: "21.0.13+9", platforms: {
    "darwin-arm64": { top: "jdk-21.0.13+9", home: "jdk-21.0.13+9/Contents/Home", url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz", sha256: "bf03…d04a", size: 199754598, installedSize: 351399936 },
    "linux-x64": { top: "jdk-21.0.13+9", home: "jdk-21.0.13+9", url, sha256, size, installedSize } } },
  frida: { version: "17.23.2", napi: 8, installedSize: 98189312, platforms: {
    "darwin-arm64": { url: "https://github.com/frida/frida/releases/download/17.23.2/frida-v17.23.2-napi-v8-darwin-arm64.tar.gz", sha256: "850f…3340", size: 38219481 },
    "linux-x64": { … }, /* linux-arm64, darwin-x64 only if the release publishes them */ } },
}
```

Write the full 64-hex digests in the file (the Global Constraints carry them).

- Produces `reaPlatform({ platform, arch, darwinMajor }, manifest = reaManifest): { key: string|null, available: boolean, reason: string|null, core: boolean, ghidra: { entry, jdk } | null, ghidraReason: string|null, frida: object|null, fridaReason: string|null }` — `ghidra.entry` is the platform's fields merged with the chosen variant (`{ kind, top, installDir, decompiler, installedSize, name?, url, sha256, size, auth? }`), `ghidra.jdk` the JDK platform entry; `darwinMajor` is `Number(os.release().split(".")[0])` on darwin; ghidra variant = the highest `minDarwin <= darwinMajor`; below 24 → `rea.ghidraMacosTooOld`; darwin-x64 → `rea.ghidraIntelMac`; linux-arm64 → `rea.ghidraLinuxArm64`; any other OS/arch → `available: false`, `rea.platformUnavailable`.
- Produces `reaCore(): { ref: { registry: "npm", name, version }, lockText: string, integrity: string, program, args }` reading `rea-package-lock.json` as text (no reformatting).

- [ ] **Step 1: Pin the open upstream values.** On the day: take the Ghidra 12.1.4 zip URL, SHA-256 and size from the `Ghidra_12.1.4_build` release on github.com/NationalSecurityAgency/ghidra; Temurin linux-x64 from Adoptium's `.sha256.txt`; frida prebuilds for the remaining platforms from the 17.23.2 release; download each once and compare size + SHA-256 before writing them. Run `node scripts/refresh-rea-lock.mjs` (resolves `rea-agents@6.8.0` with the managed Node toolchain via `resolveNpm`, writes the lock and prints the registry integrity).

- [ ] **Step 2: Write the failing tests**

```js
test("darwin-arm64 on macOS 15 picks the sequoia bottle, 26 and newer the tahoe bottle", ...)
  // reaPlatform({platform:"darwin",arch:"arm64",darwinMajor:24}).ghidra.entry.name === "arm64_sequoia"
  // darwinMajor 25 and 30 → "arm64_tahoe"; 23 → ghidra null, ghidraReason === serverMessages.rea.ghidraMacosTooOld
test("linux-x64 gets the official zip; linux-arm64 and Intel Macs get Core and a Ghidra reason", ...)
test("win32 and other arches are unavailable", ...)
test("every pinned download is https, on an allowed source, with a 64-hex SHA-256 and a size", ...)
  // iterate entries; new URL(url).hostname in reaSources and path prefix matches
test("the committed lock passes the npm lock check for rea-agents 6.8.0", ...)
  // const { ref, lockText, integrity } = reaCore();
  // const checked = checkNpmLock(lockText, { ref, integrity, registry: "https://registry.npmjs.org" });
  // assert.equal(JSON.parse(lockText).packages[""].dependencies["rea-agents"], "6.8.0");
  // assert.equal(JSON.parse(lockText).packages["node_modules/frida"].version, "17.23.2");
  // assert.equal(checked.needsScripts, true) // frida's script exists and is never run
test("the lock matches the manifest text npm ci expects", ...)
  // JSON.parse(npmManifestText(ref)).dependencies deepEquals lock packages[""].dependencies
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/unit/rea-manifest.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `rea-manifest.js`** (pins + `reaPlatform` + `reaCore`; header comment as in `chromium-manifest.js`: source of each checksum, check date, how to update) and the reasons in the `rea` catalog.

- [ ] **Step 5: Run tests**

Run: `node --test tests/unit/rea-manifest.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/tools/rea-manifest.js server/features/tools/rea-package-lock.json scripts/refresh-rea-lock.mjs .prettierignore server/lib/i18n tests/unit/rea-manifest.test.js
git commit -m "feat: pin REA's components per platform with a committed lockfile"
```

---

### Task 4: Ghidra and JDK component installer

**Files:**

- Create: `server/features/tools/rea-components.js`
- Create: `server/features/tools/rea-checks.js`
- Modify: `server/lib/i18n/{de,en}/rea.js`
- Test: `tests/integration/rea-components.test.js`

**Interfaces:**

- Consumes: `verifiedDownload`, `reaSources` (Task 2); `unpackTarGz`, `unpackZip` (Task 1); `reaPlatform` entries (Task 3); `run` from `tool-run.js`.
- Produces (`rea-components.js`):
  - `reaComponentIds = ["rea-ghidra", "rea-jdk"]`
  - `managedReaComponent(root: string, id: string): { version: string, directory: string, home: string } | null` — `home` is the real path of `GHIDRA_INSTALL_DIR` (ghidra) or `JAVA_HOME` (jdk) inside the version directory; null unless link, record and home all check out (pattern: `managedChromium`).
  - `installReaComponent({ root, id, version, entry, fetchImpl, signal, run, env, platform, progress }): Promise<{ version, directory, home }>`
  - `removeReaComponent(root: string, id: string): Promise<void>`
  - `sweepReaComponents(root: string): void`
- Produces (`rea-checks.js`): `checkGhidra({ directory, entry, version, platform, run, env, signal }): Promise<void>`, `checkJdk({ directory, entry, version, platform, run, env, signal }): Promise<void>`.
- Layout: version dir `<root>/.packages/<id>-<uuid>`, record `agentpier-rea.json` `{ id, version, platform, home }` (home relative), link `<root>/<id>`, temp work `<root>/.install-*`, temp link `<root>/.<id>-link-<uuid>`.

- [ ] **Step 1: Write the failing tests** (fixtures: `tarGz` with `ghidra/12.1.4/libexec/Ghidra/application.properties` containing `application.version=12.1.4` and an executable fake `decompile`; a JDK tar with `jdk-21.0.13+9/bin/java` as `#!/bin/sh\necho 'OpenJDK Runtime Environment Temurin-21.0.13+9' >&2`; a Ghidra zip via `yazl` for linux; served by a local HTTP server):

```js
test("installs Ghidra, checks its version and switches the link atomically", ...)
  // managedReaComponent(root,"rea-ghidra").home === realpath(<dir>/ghidra/12.1.4/libexec)
test("installs the JDK and checks the version java reports", ...)
test("a JDK that reports another version is refused and nothing is published", ...) // rea.jdkVersionMismatch
test("Ghidra without the decompiler is refused", ...) // rea.ghidraDecompilerMissing
test("on Linux a decompiler with unresolved libraries names them", ...) // run stub returns ldd "libx.so => not found"
test("on macOS the unpacked folder loses quarantine attributes (xattr -cr)", ...) // run stub records the call
test("an update keeps the previous version until the next install, then prunes it", ...)
test("a failed install keeps the previous version active and leaves no version folder", ...)
test("a full disk reports rea.diskFull", ...) // fetchImpl body stream errors with code ENOSPC
test("sweep removes work folders, stray links and unpublished versions only", ...)
test("remove deletes the link and every version folder of that component only", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/rea-components.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** following `installChromium` step for step: work dir → `verifiedDownload` (`allow: reaSources`, progress → `rea.downloading(name, percent)`) → unpack by `entry.kind` (`tar.gz` default) into the new version dir → check → write record (`flag: "wx"`) → atomic link swap (`symlink` temp + `rename`) → prune keeping new + previous (read the active link at prune time like `pruneGithubMcpPackages`). Checks: darwin `run("/usr/bin/xattr", ["-cr", directory])` (errors ignored); Ghidra: `application.properties` has `application.version=<version>`, decompiler is a regular executable file inside `installDir`, Linux `ldd` on the decompiler; JDK: `<home>/bin/java -version` output contains `version` (e.g. `21.0.13+9`). `ENOSPC` anywhere → `rea.diskFull`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/rea-components.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/tools/rea-components.js server/features/tools/rea-checks.js server/lib/i18n tests/integration/rea-components.test.js
git commit -m "feat: install Ghidra and the JDK as pinned REA components"
```

---

### Task 5: Managed MCP server rows (origin `managed`)

**Files:**

- Create: `server/features/mcp-servers/managed-servers.js`
- Modify: `server/features/mcp-servers/server-origins.js` (split wizard origins from all origins)
- Modify: `server/features/mcp-servers/mcp-server-store.js` (constructor: `this.managed = new ManagedServers(this.db)`; `publicServer`: spread `this.managed.publicFields(row.id)`; `create(...)`: option `managed = null` written in the same transaction) — net ≤ 6 lines
- Modify: `server/features/mcp-servers/central-changes.js:66` and `server/features/assistants/mcp-changes.js:212-232` (pass `managed` through)
- Modify: `server/http/routes/mcp-servers.js` (create origin from wizard origins; PUT and DELETE guards), `server/http/routes/mcp-packages.js` (guards on `package/update`, `package/reinstall`, `package/program`)
- Modify: `server/lib/i18n/{de,en}/mcp-servers.js` (`managedLocked`, `managedRemoveThroughTool`)
- Test: `tests/unit/managed-servers.test.js`, `tests/integration/managed-mcp-routes.test.js`

**Interfaces:**

- Produces:
  - `MCP_SERVER_WIZARD_ORIGINS = ["manual", "paste", "directory"]`, `MCP_SERVER_ORIGINS = [...MCP_SERVER_WIZARD_ORIGINS, "managed"]` (audit keeps all; the create route accepts only wizard origins).
  - `class ManagedServers(db)` — table `managed_servers(server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE, tool TEXT NOT NULL, locked_env TEXT NOT NULL DEFAULT '[]')`; methods `get(serverId): { tool: string, lockedEnv: string[] } | null`, `put(serverId, { tool, lockedEnv })`, `setLockedEnv(serverId, names: string[])`, `byTool(tool): string | null` (server id), `publicFields(serverId): { managed?: { tool, lockedEnv } }`.
  - `McpServerStore.create(input, { …, managed })` — `managed: { tool, lockedEnv }` stored with the row.
  - `requireOwnerPatch(servers: McpServerStore, id: string, patch: object): void` — throws `problem(mcpServers.managedLocked, 409)` when `id` is managed and `patch` has `name`, `command`, `args`, `cwd`, `transport`, `source`, or `env` sets/drops a key in `lockedEnv`.
  - `requireUnmanaged(servers, id): void` — throws `problem(mcpServers.managedRemoveThroughTool, 409)` for a managed row.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/managed-servers.test.js (real McpServerStore in a temp data dir)
test("a managed row reports managed.tool and its locked env names", ...)
test("deleting the server row cascades the managed marker", ...)
test("requireOwnerPatch allows own env keys, timeouts and nothing else changes", ...)
  // patch { revision, env: { MY_KEY: "1" } } passes; { env: { JAVA_HOME: null } } throws managedLocked;
  // { args: ["x"] }, { name: "y" }, { source: {...} } throw managedLocked
test("an unmanaged row is never refused", ...)
test("a store from before the table opens and gains it", ...)

// tests/integration/managed-mcp-routes.test.js (app fixture as in tests/integration/api.test.js)
test("PUT a locked field or managed env key of a managed row answers 409 managedLocked", ...)
test("PUT an own env key on a managed row succeeds and keeps the managed keys", ...)
test("DELETE and package update/reinstall/program on a managed row answer 409", ...)
test("binding a managed row to a CLI through PUT /mcp-servers/:id/clis works", ...)
test("POST /mcp-servers with origin 'managed' creates an unmanaged row audited as 'manual'", ...)
  // created.managed === undefined; audit event details.origin === "manual"
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/managed-servers.test.js tests/integration/managed-mcp-routes.test.js`
Expected: FAIL — module not found / 200 instead of 409

- [ ] **Step 3: Implement** the table class (pattern: `CliEntryStore` / `PackageRecords`: `CREATE TABLE IF NOT EXISTS`, JSON list parsed defensively), the store hooks, the pass-through of `managed` in both create paths, and the route guards before any other work in each handler (PUT `/mcp-servers/:id` incl. its `changeSource` branch, DELETE `/mcp-servers/:id`, the three package routes). Grep `changes().remove(` and `mcpServerChanges.remove(` across `server/http/routes/` and guard every owner-facing deletion path found.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/managed-servers.test.js tests/integration/managed-mcp-routes.test.js && npm run check:structure`
Expected: PASS; `mcp-server-store.js` ≤ 600 lines

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- mcp-servers
git add server/features/mcp-servers server/features/assistants/mcp-changes.js server/http/routes/mcp-servers.js server/http/routes/mcp-packages.js server/lib/i18n tests/unit/managed-servers.test.js tests/integration/managed-mcp-routes.test.js
git commit -m "feat: mark MCP server rows AgentPier manages and lock their command"
```

---

### Task 6: Frozen Core install with the Frida prebuild

**Files:**

- Create: `server/features/mcp-packages/frozen-install.js`
- Create: `server/features/tools/rea-frida.js`
- Modify: `server/features/mcp-packages/package-install-job.js` (one call after `adapter.install(...)`, before `programsAfterInstall`)
- Modify: `server/features/mcp-packages/mcp-packages.js` (constructor option `afterInstall = null` → `this.afterInstall`) — ≤ 2 lines
- Modify: `server/lib/i18n/{de,en}/rea.js`
- Test: `tests/integration/rea-core.test.js`

**Interfaces:**

- Consumes: `McpPackages` internals the same way `package-install-job.js` and `program-choice.js` do (`service.changes`, `service.install`, `service.pendingRecord`, `service.claiming`, `service.checkStored`, `service.adapterOf`, `service.jobs`); `ManagedServers` via `create(..., { managed })` (Task 5); `verifiedDownload` (Task 2); `unpackTarGz` (Task 1).
- Produces (`frozen-install.js`):
  - `frozenPreview(service, { ref, lockText, integrity }): Preview` — the object `reinstall()` builds (`allowScripts: false`, `constraints: []`, `manifestText`, `digest` from `checkStored`, `needsScripts` from the lock check).
  - `createFrozenServer(service, input: { name, transport: "stdio", args, env }, { clis: string[], frozen, program: { name, path }, managed: { tool, lockedEnv } }): Promise<PublicServer>` — creates the row with `confirmStdio: true`, `pendingCommand: true`, the pending package record and the managed marker in one write, then starts the install job (same `claiming` discipline as `createServer`).
  - `installFrozen(service, serverId, frozen, program, kind: "install"|"update"|"reinstall"): JobSnapshot`
  - `jobSettled(service, serverId): Promise<void>` — resolves when the server's current job ends (never rejects).
- Produces in `runInstall`: `await service.afterInstall?.(serverId, { directory: stage, ref, toolchain, execute: service.execute, signal, log })`.
- Produces (`rea-frida.js`): `placeFridaPrebuild({ directory: string, entry, toolchain: { nodePath }, execute, fetchImpl, signal }): Promise<void>` — downloads into `<directory>/.frida-work/`, `unpackTarGz(…, top "build")`, requires `build/frida_binding.node` as a regular file, requires `node_modules/frida` (and `build`) to be real folders without links, moves the binding to `node_modules/frida/build/frida_binding.node` (mode 0o755), removes the work folder, then loads it once: `execute(toolchain.nodePath, ["--input-type=module", "-e", <script>, directory])` where the script resolves `frida` with `createRequire(path.join(argv[1], "package.json"))`, imports it and exits 1 unless `typeof getDeviceManager === "function"`. Failure → `rea.fridaFailed`.

- [ ] **Step 1: Write the failing tests** with `packageService(t, published)` from `tests/helpers/mcp-packages-service.js`, publishing a fake `rea-agents@6.8.0` (`bin: { rea: "scripts/rea.mjs" }`, `optionalDependencies: { frida: "17.23.2" }`) and a fake `frida@17.23.2` whose `package.json` has `scripts.install` writing a marker file and whose `build/src/frida.js` exports `getDeviceManager` but needs the binding; resolve the "committed" lock in the test with `resolveNpm`; serve a frida prebuild `tarGz([{ name: "build/frida_binding.node", … }])` locally:

```js
test("createFrozenServer stores a managed row and installs the frozen lock without scripts", ...)
  // server.managed.tool === "rea"; server.args === [<program path>, "mcp"]; marker file absent
test("the afterInstall hook places the Frida binding before the install is committed", ...)
  // fs.statSync(<install>/node_modules/frida/build/frida_binding.node).isFile()
test("a wrong Frida checksum fails the job and the server keeps its previous install", ...)
test("a lock that does not match the pinned integrity is refused before npm runs", ...) // MCP_PACKAGE_INTEGRITY_MISMATCH
test("installFrozen 'update' switches to a new lock and prunes the old install", ...)
test("installFrozen 'reinstall' without the hook leaves no binding (Frida off)", ...)
test("a deleted managed row cancels its running frozen install", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/rea-core.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** `frozen-install.js` (no preview map, no owner program choice: the program is pinned) and `rea-frida.js`; add the one-line hook in `runInstall` and the constructor option. The REA-specific decision (which server, whether Frida is selected) stays out of `mcp-packages/`: the hook is assigned by `ReaTool` (Task 8).

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/rea-core.test.js tests/unit/mcp-packages-service.test.js tests/unit/mcp-package-state.test.js && npm run check:structure`
Expected: PASS; `mcp-packages.js` ≤ 600 lines

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/mcp-packages server/features/tools/rea-frida.js server/lib/i18n tests/integration/rea-core.test.js
git commit -m "feat: install REA's core from a committed lock with Frida's prebuild"
```

---

### Task 7: REA environment and bring-your-own settings

**Files:**

- Create: `server/features/tools/rea-environment.js`
- Modify: `server/lib/i18n/{de,en}/rea.js`
- Test: `tests/unit/rea-environment.test.js`

**Interfaces:**

- Produces:
  - `reaManagedKeys`: `["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "REA_MCP_INPUT_SCHEMA_PROFILE", "REA_ANALYSIS_PROVIDER", "GHIDRA_INSTALL_DIR", "JAVA_HOME", "HOPPER_LAUNCHER_PATH", "REA_IDA_MCP_CONFIG", "REA_JEB_MCP_URL"]`
  - `reaHome(dataDir: string): string` → `<dataDir>/rea/home`; `prepareReaHome(dataDir): string` creates `home`, `home/tmp`, `home/.config`, `home/.cache`, `home/.local/share`, `home/.claude`, `home/.codex` with mode 0o700.
  - `cleanReaSettings(input): { provider: "ghidra"|"ida", hopperPath: string|null, idaConfig: string|null, jebUrl: string|null }` — empty strings become null; paths absolute, ≤ 4096 chars, no control characters; `jebUrl` through `mcpUrl()` (http/https, no credentials or fragment); `provider` defaults to `"ghidra"`; `"ida"` requires `idaConfig`. Errors: `problem(rea.invalidPath | rea.invalidJebUrl | rea.idaConfigRequired | rea.invalidProvider, 400)`.
  - `reaEnvironment({ home: string, ghidra: { home } | null, jdk: { home } | null, settings }): Record<string, string>` — HOME/TMPDIR/XDG_*/`CLAUDE_CONFIG_DIR=<home>/.claude`/`CODEX_HOME=<home>/.codex`, `REA_MCP_INPUT_SCHEMA_PROFILE=compact`, `REA_ANALYSIS_PROVIDER`, `GHIDRA_INSTALL_DIR` + `JAVA_HOME` only when both components are installed, BYO keys only when set.
  - `reaEnvPatch(current: Record<string,string>, wanted: Record<string,string>): Record<string, string|null>` — sets managed keys that differ, `null` for managed keys no longer wanted; never names a non-managed key.

- [ ] **Step 1: Write the failing tests**

```js
test("Core alone: controlled home, compact schema, provider ghidra, no Ghidra or JDK keys", ...)
test("Ghidra and JDK installed: GHIDRA_INSTALL_DIR and JAVA_HOME are their real homes", ...)
test("bring-your-own settings map to HOPPER_LAUNCHER_PATH, REA_IDA_MCP_CONFIG, REA_JEB_MCP_URL", ...)
test("CLAUDE_CONFIG_DIR and CODEX_HOME point into REA's own home, never the CLI's", ...)
test("cleanReaSettings refuses relative paths, control characters, credential URLs and ida without config", ...)
test("reaEnvPatch drops removed managed keys and never touches an owner key", ...)
  // current { JAVA_HOME: "/a", MY_TOKEN: "x" }, wanted {} → { JAVA_HOME: null }
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/rea-environment.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** the pure functions; messages in the `rea` catalog.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/rea-environment.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/tools/rea-environment.js server/lib/i18n tests/unit/rea-environment.test.js
git commit -m "feat: derive REA's controlled environment from its components"
```

---

### Task 8: ReaTool service, routes, skill copies, server-start update and wiring

**Files:**

- Create: `server/features/tools/rea-tool.js`
- Create: `server/features/tools/rea-skills.js`
- Create: `server/http/routes/rea.js`
- Modify: `server/app.js` (mount `reaRoutes(services)`; run `services.rea?.start()` after `services.mcpPackages?.start()` settles in the existing `listening` handler)
- Modify: `server/application/services.js` (construct `ReaTool` after `mcpPackages`; `mcpPackages.afterInstall`; `rea.inUse`; CentralMcpChanges `onSaved` also calls `services.rea?.bindingsChanged()`; add `rea` to `services`)
- Modify: `server/application/shutdown.js` (`await services.rea?.close()` before packages close)
- Modify: `server/http/routes/workspace.js:49` (add `services.rea?.utility()` to `utilities`)
- Modify: `server/lib/i18n/{de,en}/rea.js`
- Test: `tests/integration/rea-tool.test.js`, `tests/unit/rea-skills.test.js`

**Interfaces:**

- Consumes: everything from Tasks 3–7; `PackageSkills` (`mcpPackages.skills`), `ExtensionsStore.skillProfiles()`, `ExtensionsStore.removeSkill(...)`, `McpServerStore.targetsOf(id)`, `envValues(id)`, `ManagedServers.byTool/setLockedEnv`.
- Produces:

```js
class ReaTool {
  constructor({ dataDir, servers, changes, packages, extensions, audit = null, manifest = reaManifest,
                core = reaCore(), platform = process.platform, arch = process.arch,
                darwinMajor = …, fetchImpl = fetch, run, env = cleanEnvironment() })
  inUse: () => Promise<boolean>              // assigned in services.js
  serverId(): string | null                  // managed row id (ManagedServers.byTool("rea"))
  state(): ReaState
  utility(): { id: "rea", name: "REA", utility: true, installed: boolean, version: string|null,
               pinnedVersion: string, updateAvailable: boolean, status: string }
  apply({ components: { ghidra: boolean, frida: boolean }, settings, confirmInstall }): Promise<ReaState>
  update(): Promise<ReaState>
  uninstall(): Promise<ReaState>
  start(): Promise<void>
  bindingsChanged(): Promise<void>
  afterInstall(serverId, ctx): Promise<void>  // assigned to mcpPackages.afterInstall
  close(): Promise<void>
}
// ReaState:
{ available, reason, status: "idle"|"running"|"succeeded"|"failed", step: string|null, message: string,
  installed: boolean, serverId: string|null, serverName: string|null, updateAvailable: boolean,
  components: {
    core:   { installed, version, pinnedVersion, packageStatus, downloadSize, installedSize },
    ghidra: { available, reason, installed, version, pinnedVersion, jdkVersion, jdkPinnedVersion, downloadSize, installedSize },
    frida:  { available, reason, installed, version, pinnedVersion, downloadSize, installedSize } },
  settings: { provider, hopperPath, idaConfig, jebUrl } }
```

- `rea-skills.js`: `syncReaSkills({ serverId, servers, packageSkills, extensions }): Promise<void>` — skill `reverse-engineer-anything`; targets = `extensions.skillProfiles()` whose `tool` is in `servers.targetsOf(serverId).clis`; installs into each target without an owned copy via `packageSkills.install(serverId, { profileId, names: ["reverse-engineer-anything"], confirmInstall: true })`, skipping a profile that answers 409 (the owner's own folder of that name wins); removes owned copies (`removeSkill(..., { verify: true })`) in profiles no longer bound.
- Settings file `<data>/rea/settings.json` (`writePrivate`): `{ serverId, components: { ghidra, frida }, settings, requested?: { components, settings } }`.
- Routes (`server/http/routes/rea.js`; under `/rea` so they never meet `DELETE /tools/:id`): `GET /rea` → `state()`; `POST /rea` → 202 `apply(body)`; `POST /rea/update` → 202 `update()`; `DELETE /rea` → `uninstall()`. Audit `mcp.created` / `mcp.deleted` with `origin: "managed"` for the row.

- [ ] **Step 1: Write the failing tests** (`tests/integration/rea-tool.test.js`: real stores and `packageService` from Task 6's setup, local HTTP for Ghidra/JDK/Frida fixtures, `run` stub for checks, `inUse` stub):

```js
test("first install with confirmInstall creates the managed row bound to Claude Code", ...)
  // state.installed; servers.targetsOf(id).clis deepEqual ["claude"]; server.managed.tool === "rea"
  // env names include GHIDRA_INSTALL_DIR, JAVA_HOME, REA_MCP_INPUT_SCHEMA_PROFILE, HOME
test("install without confirmInstall is refused with 409 rea.confirmationRequired", ...)
test("an existing directory row named rea stays untouched; the managed row is rea-agentpier", ...)
test("removing Ghidra drops GHIDRA_INSTALL_DIR and JAVA_HOME and keeps the owner's own env keys", ...)
test("turning Frida off reinstalls Core without the binding; on places it again", ...)
test("changing only bring-your-own settings updates the env without reinstalling Core", ...)
test("start() installs what --with-rea requested and clears the request", ...)
test("start() brings an outdated Ghidra, JDK or Core lock to the pins", ...)
test("start() skips the update while REA is in use and reports updateAvailable", ...)
test("uninstall, Ghidra removal and Frida off are refused while in use (409 rea.inUse)", ...)
test("uninstall removes the row, skill copies, Ghidra, JDK and <data>/rea", ...)
test("a second apply while a job runs is refused (409 rea.busy)", ...)
test("a platform without REA reports available false and refuses apply", ...)
test("GET/POST/DELETE /rea answer as the service does and audit origin managed", ...)

// tests/unit/rea-skills.test.js
test("copies the skill into profiles of bound CLIs only", ...)
test("an owner's own skill folder of the same name is left alone", ...)
test("unbinding a CLI removes the owned copy there; a changed copy is only forgotten", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/rea-tool.test.js tests/unit/rea-skills.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**
  - One REA job at a time (`this.job`), each a sequence of steps whose progress lands in `state().step/message`: Ghidra + JDK (`installReaComponent` / `removeReaComponent`) → Core (`createFrozenServer` on first install with name `rea`, else `rea-agentpier` when `rea` is taken case-insensitively; `installFrozen(…, "reinstall")` when Frida changed; `installFrozen(…, "update")` when the committed lock digest or version differs from the record) → `await jobSettled(...)` → env: `changes.update(id, { revision, env: reaEnvPatch(servers.envValues(id), reaEnvironment(...)) }, { confirmStdio: true })` then `servers.managed.setLockedEnv(id, keys present)` → `syncReaSkills`.
  - `afterInstall(serverId, ctx)` places the Frida binding only when `serverId === this.serverId()` (or the row being created) and Frida is selected and available.
  - Refusals: `rea.inUse` (409) for uninstall and for any change that removes or replaces files (Ghidra off, Frida toggle, update); `rea.busy` (409); `rea.confirmationRequired` (409) on first install; platform reason (409).
  - `start()`: `sweepReaComponents`; if `requested` and no row → apply it; else if installed and outdated and `!(await inUse())` → `update()`; always `bindingsChanged()` at the end. Never throws (log like `logFailure`).
  - `services.js` `rea.inUse`: true when `(await sessions.list())` has a `status === "running"` session whose `tool` is in the row's bound CLIs, or `targetsOf(id).agents.length && services.assistants?.runtime?.client?.ready`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/rea-tool.test.js tests/unit/rea-skills.test.js tests/integration/api.test.js && npm run check:structure`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea
git add server/features/tools/rea-tool.js server/features/tools/rea-skills.js server/http/routes/rea.js server/app.js server/application/services.js server/application/shutdown.js server/http/routes/workspace.js server/lib/i18n tests/integration/rea-tool.test.js tests/unit/rea-skills.test.js
git commit -m "feat: install, update and remove REA as a managed tool"
```

---

### Task 9: Installer option `--with-rea`

**Files:**

- Create: `server/features/tools/rea-provisioning.js`
- Modify: `scripts/release-install.mjs`, `scripts/setup-resume.mjs`, `scripts/setup-options.mjs`, `scripts/setup.sh`, `scripts/install-bootstrap.sh` — every place `--with-agent-browser` / `withAgentBrowser` / `agentBrowser` appears gets the REA counterpart
- Test: `tests/integration/rea-provisioning.test.js`

**Interfaces:**

- Consumes: `reaPlatform`, `installReaComponent`, `managedReaComponent` (Tasks 3–4); settings file shape (Task 8).
- Produces: `provisionRea({ dataDir, enable = false, platform, arch, darwinMajor, manifest = reaManifest }, { install = installReaComponent, fetchImpl = fetch } = {}): Promise<null | { status: "ready"|"pending"|"unavailable"|"failed", ghidra?: string|null, message?: string }>` — `null` when not enabled and REA is not installed; with `enable` and no REA: installs Ghidra + JDK where available and writes `requested: { components: { ghidra: true, frida: true }, settings: { provider: "ghidra" } }` → `pending` (Core and registration finish at the next server start); with REA installed: brings Ghidra/JDK to the pins → `ready`. Never throws; loads `tool-run.js` and `account-store.js` lazily (the scripts run before dependencies exist, like `provisionAgentBrowser`).
- Results: `rea` key in the JSON result of `release-install.mjs` and `setup-resume.mjs`; `withRea` in `resolveSetupOptions`; `--with-rea` in `installerArguments`.

- [ ] **Step 1: Write the failing tests** (pattern: `tests/integration/agent-browser-provisioning.test.js`):

```js
test("without --with-rea and without REA nothing happens", ...)            // null
test("--with-rea installs Ghidra and the JDK and leaves a request for the server", ...) // pending
test("an installed REA is brought to the pinned Ghidra and JDK on every installer run", ...)
test("a failed download never fails the installation", ...)               // status failed, no throw
test("Intel Macs and linux-arm64 get pending Core with a Ghidra reason", ...)
test("resolveSetupOptions and installerArguments carry --with-rea", ...)
test("runInstaller accepts --with-rea and reports rea in its result", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/rea-provisioning.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** `provisionRea` and wire the option through the scripts next to `--with-agent-browser` (including `setup.sh`'s usage text and both option lists in `install-bootstrap.sh`).

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/rea-provisioning.test.js tests/integration/agent-browser-provisioning.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/tools/rea-provisioning.js scripts tests/integration/rea-provisioning.test.js
git commit -m "feat: provision REA through the installers with --with-rea"
```

---

### Task 10: REA card and install dialog

**Files:**

- Create: `web/features/tools/ReaDialog.jsx`, `web/features/tools/ReaComponents.jsx`, `web/features/tools/ReaOwnTools.jsx`, `web/features/tools/useRea.js`, `web/features/tools/rea.css`
- Create: `web/lib/i18n/de/rea.js`, `web/lib/i18n/en/rea.js`, `web/lib/i18n/messages/rea.js`
- Modify: `web/features/dashboard/ToolGrid.jsx` (REA card), `web/app/AppDialogs.jsx` (modal type `rea`), `web/lib/providers.js` (`rea: "REA"`), `web/components/ProviderMark.jsx` if it has no generic fallback, `web/lib/i18n/{de,en}/dashboard.js` (`toolGridRea`)
- Test: `tests/browser/rea-tool.spec.js`

**Interfaces:**

- Consumes: `GET /api/rea`, `POST /api/rea`, `POST /api/rea/update`, `DELETE /api/rea` and the `ReaState` shape (Task 8); `utilities[]` entry `{ id: "rea", … }` from `/api/state`; `formatBytes` from `web/lib/format-bytes.js`.
- Produces: `useRea({ request })` → `{ state, loading, error, apply(desired), update(), uninstall(), refresh() }` polling while `state.status === "running"`.
- UI decisions:
  - Card: one button — **Install** (not installed) or **Manage** (installed), both `setModal({ type: "rea" })`; version line like Chrome for Testing; update badge when `updateAvailable`.
  - Dialog (`Modal`): component rows with `CheckRow` — Core (checked, disabled), **Ghidra with decompiler + Temurin JDK**, **Frida**; each row shows version, download and installed size; unavailable rows are disabled with their server reason; a total line (download, installed) recomputed from the ticked rows. Below: **Your own tools** (`ReaOwnTools`: Hopper launcher path, IDA MCP bridge config, JEB MCP URL, analysis provider via `Segmented` Ghidra/IDA). Safety notes (dual use; DISCLAIMER forbids DRM, licence-check and anti-cheat circumvention; untrusted binaries in a VM or separate account; only `morluto/rea` is genuine). Sandbox notice listing what needs an unsandboxed session (Task 12 confirms the list). An acknowledgement `CheckRow` must be ticked before the first **Install**; it sends `confirmInstall: true`. Status line with `step`/`message`; **Update** when `updateAvailable`; **Uninstall REA** with inline confirm (pattern `McpRemoveConfirmation`); server errors shown via `ErrorMessage`/`serverText`.

- [ ] **Step 1: Write the failing browser test** (route stubs as in `tests/browser/managed-chromium.spec.js`, `localStorage agentpier-language = "en"`):

```js
test("the REA dialog lists components with sizes and totals, safety and sandbox notes", ...)
  // card "REA" → Install; dialog contains "Ghidra with decompiler + Temurin JDK", "Frida",
  // "DRM", "morluto/rea", "unsandboxed"; total changes when Ghidra is unticked
test("install needs the acknowledgement and sends the chosen components and own tools", ...)
  // Install disabled until the acknowledgement is ticked; POST /api/rea body deepEquals
  // { components: { ghidra: false, frida: true }, settings: { provider: "ida", idaConfig: "/x/ida.json", … }, confirmInstall: true }
test("an unavailable Ghidra row is disabled and names the reason", ...)
test("an installed REA offers Update and Uninstall; a 409 in use is shown", ...)
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx playwright test tests/browser/rea-tool.spec.js`
Expected: FAIL — no "REA" card

- [ ] **Step 3: Implement** the components, hook, catalogs (every string de + en) and the card/dialog wiring. Add no primitive; if one is missing, add it to `web/components/`, `docs/ui-guide.md` and the gallery in this task.

- [ ] **Step 4: Run tests**

Run: `npm run build && npx playwright test tests/browser/rea-tool.spec.js tests/browser/managed-chromium.spec.js && node --test tests/unit/ui-guide-rules.test.js tests/unit/i18n-catalogs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- rea dashboard
git add web tests/browser/rea-tool.spec.js
git commit -m "feat: add the REA card and install dialog"
```

---

### Task 11: The managed row in the MCP pages and the directory hint

**Files:**

- Modify: `web/features/mcp-servers/wizard/McpServerOverview.jsx` (no Remove for `server.managed`; a note with a link to `/coding/clis?tab=install` instead; the source card has no **Change**)
- Modify: `web/features/mcp-servers/McpPackagePanel.jsx` (hide update / reinstall / own-command actions for `server.managed`)
- Modify: `web/features/mcp-servers/wizard/EditSettingsStep.jsx` and `web/features/mcp-servers/McpSecretRows.jsx` (managed env names read-only; own keys editable)
- Modify: `web/features/mcp-servers/wizard/curated-hints.js` (`managed: "rea"` on the REA entry), `web/features/mcp-servers/wizard/CuratedHint.jsx` (link **Install REA with AgentPier** → `/coding/clis?tab=install`)
- Modify: `web/lib/i18n/{de,en}/mcp-servers.js`, `web/lib/i18n/{de,en}/mcp-directory.js` (REA hint points rewritten: Ghidra/JDK/Frida now installable by AgentPier; install-scripts point removed for the managed path)
- Test: `tests/browser/rea-tool.spec.js` (append), `tests/unit/mcp-curated-hints.test.js` (extend)

**Interfaces:**

- Consumes: `server.managed: { tool: "rea", lockedEnv: string[] }` in `/api/mcp-servers` (Task 5).

- [ ] **Step 1: Write the failing tests**

```js
// tests/browser/rea-tool.spec.js
test("a managed REA row has no Remove, links to the REA card and locks managed env names", ...)
  // overview of server { managed: { tool: "rea", lockedEnv: ["JAVA_HOME"] }, envNames: ["JAVA_HOME","MY_KEY"] }
  // no button "Remove"; link "Manage REA" href contains "/coding/clis?tab=install";
  // settings step: JAVA_HOME row read-only, MY_KEY editable
// tests/unit/mcp-curated-hints.test.js
test("the REA hint carries the managed install link; look-alikes get none", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && npx playwright test tests/browser/rea-tool.spec.js && node --test tests/unit/mcp-curated-hints.test.js`
Expected: FAIL

- [ ] **Step 3: Implement** the read-only rendering and the hint link (plain link component already used in the app; no new primitive).

- [ ] **Step 4: Run tests**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npm run i18n:confirm -- mcp-servers mcp-directory
git add web tests/browser/rea-tool.spec.js tests/unit/mcp-curated-hints.test.js
git commit -m "feat: show the managed REA row as locked and link the directory hint"
```

---

### Task 12: Sandbox check, docs, spike install and cleanup

**Files:**

- Modify: `docs/mcp.md` (new section "Managed REA" before "Worked example: REA"; the worked example points to it; keep the `#worked-example-rea` anchor), `docs/sandbox.md` ("Tools that do not run sandboxed": REA's list), `docs/installation.md` (`--with-rea` next to `--with-agent-browser`, result key `rea.status`), `docs/linux.md` (German; short `--with-rea` note under the installer section), `docs/mcp-package-qualification.md` (only if REA's qualification there changes), `README.md`, `README.de.md` (feature lists), `docs/cli-updates.md` (REA follows pins at server start, like the managed browser)
- Modify (if the check changes the list): `web/lib/i18n/{de,en}/rea.js` sandbox notice
- Delete before the PR: `docs/superpowers/plans/2026-10-27-rea-managed-tool.md`, `docs/superpowers/specs/2026-10-27-rea-managed-tool-design.md`

- [ ] **Step 1: Real sandbox check.** In a separate AgentPier instance with its own data dir, port block and tmux server (never the live service): install REA, start a nono-sandboxed Claude Code session bound to REA and an unsandboxed one; in each run `rea doctor --provider ghidra` through the MCP tools and one decompile of a small C binary; try Frida's device enumeration. Record which features fail sandboxed. Default list if the check confirms the expectation: Ghidra decompilation (JVM and Ghidra outside the session's allowed folders), Frida attach/spawn, LLDB, process listing (setuid `ps`), Hopper/IDA/JEB bridges.

- [ ] **Step 2: Spike install with real downloads** in the same instance on this Mac: full install, toggle Frida, remove Ghidra, server restart with an outdated pin (edit the manifest locally, never committed) to see the start update, uninstall while a session runs (expect refusal), then uninstall. Note durations and sizes for the PR description. `rea doctor`'s `registration`/`skill` "config_drift" is expected and not an error.

- [ ] **Step 3: Write the docs.** The managed REA section covers: where the card is (Coding › CLIs & extensions › Installation and the dashboard), components and sizes, pins and how they are updated (manifest comment, `scripts/refresh-rea-lock.mjs`), the controlled environment and which keys are locked, bring-your-own fields, default binding to Claude Code and skill copies to bound CLI profiles, removal refusal while in use, safety notes, `rea setup` never run, sandbox list. Quote every UI label exactly as in the English catalog.

- [ ] **Step 4: Full check**

Run: `npm run check && npx playwright test tests/browser/rea-tool.spec.js tests/browser/managed-chromium.spec.js`
Expected: lint, format, structure, build and all Node suites pass; browser tests pass. If a Playwright run rewrites `docs/screenshots/pipeline-permissions.png`, restore it.

- [ ] **Step 5: Commit docs, then remove the working documents**

```bash
git add docs README.md README.de.md web/lib/i18n
git commit -m "chore: document REA as a managed tool"
git rm docs/superpowers/plans/2026-10-27-rea-managed-tool.md docs/superpowers/specs/2026-10-27-rea-managed-tool-design.md
git commit -m "chore: remove the REA plan and design"
```

The PR description lists the docs checked/updated, the spike results (Step 1 and 2) and screenshots of the card and dialog.
