# Managed MCP package install (AGENTPIER-72)

Status: design approved in conversation on 2026-10-14; this document awaits the owner's review.

## Goal and context

A local (stdio) MCP server under **Accounts → MCP servers** currently needs an absolute
command that the owner installed by hand on the AgentPier host (`pipx`, `uv tool`,
`npm -g` …). `command-resolution.js` only resolves an existing executable; AgentPier
never installs anything for a server.

The trigger is a read-only OPNsense MCP server (a Python package) that the owner wants to
give to a "network architect" agent. That should not require shell work, and the same
server must also be available to the coding CLIs (Claude Code, Codex, OpenCode) through
the existing central MCP server management (`docs/mcp.md`, "Central MCP servers in the
coding CLIs").

**Outcome:** the owner picks a package from npm or PyPI and an exact version in the MCP
server form; AgentPier installs it reproducibly into a managed directory, generates the
stdio command, and the server is bound to agents and CLIs exactly like today.

**Success:** at least two npm and two PyPI servers, plus the OPNsense server, run from a
managed install, bound to an agent and to Claude Code, with a real tool call each
(see "Manual qualification").

## Decisions

- **Platforms:** Every supported AgentPier installation: macOS and Linux, arm64 and x64. _Why:_ AGENTS.md requires runtime tools to be provisioned through the installation scripts and the update path, not one machine.
- **Package code:** No package code by default: npm runs with `--ignore-scripts`, Python installs wheels only (`--only-binary :all:`). The owner can allow install scripts (npm) or source builds (Python) **per package**, with an explicit warning. _Why:_ Covers the common case safely; packages that really need a build stay possible as a deliberate choice.
- **Dependencies:** Resolve once at install, freeze the full graph with hashes, reuse it for repair; an update re-resolves and shows a diff before confirmation. _Why:_ Reproducible, and a changed transitive dependency never arrives unnoticed. Same principle as the OpenClaw runtime lock, except the lock is made at install time.
- **Model:** The install is a **source of an MCP server record** (approach 1). No separate package list. _Why:_ Fits the existing form and bindings. A shared package entity can be added later if needed.
- **Launch:** Rejected: starting through `npx`/`uvx` at every launch. _Why:_ Not reproducible, needs network at start, contradicts the frozen lock.
- **Version choice:** Versions are fetched from the registry and offered in a dropdown. _Why:_ Owner request; avoids typos and ranges.
- **Out of scope:** A catalog of recommended servers; private registries; Git, URL or local-path sources; HTTP servers (they need no install). _Why:_ Owner asked for no catalog yet; the rest widens the supply-chain surface.

## Architecture

### New feature `server/features/mcp-packages/`

Each file has one purpose and stays under the 600-line limit.

- `package-spec.js` — validates a package reference: registry `npm` | `pypi`, a name
  matching the registry's rules (npm: optional `@scope/`, lowercase, URL-safe; PyPI:
  PEP 503 normalised), an exact version (npm semver, PyPI PEP 440). Ranges, tags, URLs,
  `git+`, `file:` and paths are refused.
- `registry-metadata.js` — reads registry metadata, never installs:
  - npm: `https://registry.npmjs.org/<name>` → `versions`, `time`,
    `versions[v].deprecated`, `versions[v].bin`, `versions[v].dist.integrity`,
    `versions[v].scripts` (to detect `preinstall`/`install`/`postinstall`).
  - PyPI: `https://pypi.org/pypi/<name>/json` → `releases[v][]` with `digests.sha256`,
    `packagetype` (`bdist_wheel`/`sdist`), `yanked`, `yanked_reason`, `upload_time_iso_8601`,
    `requires_python`.
  - Returns versions newest first with date, prerelease flag, deprecated/yanked marker.
- `npm-package-install.js` — in a staging directory: write `package.json` with the exact
  dependency, `npm install --package-lock-only --ignore-scripts` to resolve, check the
  lock, then `npm ci --ignore-scripts` (without `--ignore-scripts` only when scripts are
  allowed). Environment isolation copies `runtime-install.js:246-271`: empty user/global
  npmrc, private `HOME`/`TMPDIR`, own `npm_config_cache`, minimal `PATH`,
  `proxyEnvironment()`, `--registry=https://registry.npmjs.org`, `--no-audit --no-fund`.
- `python-package-install.js` — in a staging directory: `uv venv` with the managed
  Python, `uv pip compile --generate-hashes` of a one-line requirement
  (`<name>==<version>`) to `requirements.lock`, then
  `uv pip sync --require-hashes requirements.lock` into the venv. Without the build
  opt-in both steps pass `--only-binary :all:`. `UV_INDEX_URL=https://pypi.org/simple`,
  `UV_NO_CONFIG=1`, private `HOME`/`TMPDIR`/`UV_CACHE_DIR`, minimal `PATH`.
- `lock-check.js` — refuses a lock with a source outside the allowed registries
  (`registry.npmjs.org`; `files.pythonhosted.org`), a missing hash, a link or a path
  dependency (adapts `runtime-lock.js:45-121`). Also computes the diff of two locks
  (added, removed, changed with old/new version).
- `program-select.js` — lists the package's programs (npm `bin`; Python
  `console_scripts` from the installed `entry_points.txt`) and resolves the chosen one.
- `package-store.js` — install layout, receipts, active pointer, cleanup:
  `<data>/mcp-packages/<server-id>/<install-id>/{lock, node_modules | venv, receipt.json}`
  and `<data>/mcp-packages/<server-id>/active.json`. Staging in `.stage-<uuid>`, atomic
  rename, `receipt.json` with registry, name, version, top-level integrity, lock digest,
  scripts/build flag, program, toolchain versions. Reuses `download()`
  (`operations/releases.js`), `checksum()`, `privateFolder()`, `regular()` and the
  pid/start-time lock pattern of `runtime-install-lock.js`.
- `install-jobs.js` — one background job per server (preview, install, update,
  reinstall), status `installing | ready | failed` with a stable error code, a short
  redacted log tail, deduplication like `runtime-install.js:16`.
- `toolchains.js` — managed toolchains under `<data>/toolchains/`:
  - Node `26.7.0` with its bundled npm, same archive and `nodeChecksums` as
    `assistants/runtime-manifest.js`, installed independently of the OpenClaw runtime so
    CLI-only installations work without agents.
  - `uv` at a pinned version (0.13.1 was current on 2026-10-14) from the official GitHub release asset per target
    (`uv-<arch>-apple-darwin.tar.gz`, `uv-<arch>-unknown-linux-gnu.tar.gz`), verified
    against a SHA-256 pinned in a manifest in this repo.
  - CPython at a pinned version installed by the managed `uv` (`uv python install
<version> --install-dir <data>/toolchains/python`) with `UV_PYTHON_DOWNLOADS=manual`
    afterwards so nothing downloads implicitly at install time.
  - Provisioned by `scripts/setup.sh` (through `setup-resume.mjs`), by the update path
    (`release-install.mjs` and a background stage after an update, like
    `application/assistants.js:69`), and on demand at the first package install. All
    three use the same verified download.

### Changes to existing code

- `mcp-servers/mcp-server-store.js` — new nullable `source` column (JSON) added by the
  existing `ALTER` checks (`:118-128`): `{ registry, name, version, program,
allowScripts, installId }`. `definition()` (`:233-261`) accepts a stdio record with
  `source` and no hand-written `command`; for such a record `command` and the leading
  `args` are generated and read-only. `publicServer()` returns `source` and the job
  status. A record with `source` is only compiled for agents and CLIs while its install
  is `ready`.
- Command generation: npm → `command = <data>/toolchains/node/bin/node`,
  `args = [<install>/node_modules/<pkg>/<bin path>, ...ownerArgs]` (avoids the
  `#!/usr/bin/env node` shebang, which would not find the managed Node on the Gateway
  `PATH`); PyPI → `command = <install>/venv/bin/<program>`, `args = ownerArgs`.
- `openclaw-config/mcp-servers.js` — unchanged, the generated command is absolute.
- `mcp-servers/cli-grants.js` (`stdioGrants`, `:62-117`) — for a managed install, a
  directory **read** grant on the active install and on the toolchain directory it uses
  (today a command inside the data directory gets no grant), like
  `managedCliInstallation` in `tools/tool-paths.js`.
- `mcp-servers/stdio-confirmation.js` / `central-changes.js` — the install
  confirmation replaces the stdio confirmation for that save, so the owner confirms once.
- `operations/backup.js` — the `mcp-servers` component additionally captures each
  server's `receipt.json` and lock, not `node_modules`, `venv` or toolchains. After a
  restore the server shows "install missing" and offers **Reinstall**.

## API

All under `/api`, owner only, audited by name and version without env values.

- `GET /mcp-packages/versions?registry=&name=` → versions (newest first, date,
  prerelease, deprecated/yanked).
- `POST /mcp-packages/preview` `{ registry, name, version, allowScripts }` → resolves in
  staging without installing or running package code: top-level integrity, dependency
  count and list, programs, `needsScripts` (npm install scripts in the graph; a PyPI
  dependency without a compatible wheel), `previewId` valid for a short time.
- `POST /mcp-servers` and `PUT /mcp-servers/:id` accept `source` plus `previewId` and
  `confirmInstall: true`; they start the install job and return `202` with job status.
- `POST /mcp-servers/:id/package/update` `{ version, allowScripts, previewId,
confirmInstall }` → new install next to the active one, switch only on success. The
  preview for an update includes the lock diff.
- `POST /mcp-servers/:id/package/reinstall` → installs exactly from the stored lock, no
  resolution, no new confirmation.
- `GET /mcp-servers/:id/package` → job status, receipt summary, log tail.
- Removing a server, or switching its source to "own command", removes its installs.

## UI flows (`web/features/mcp-servers/`)

- **Source switch** in `McpServerFields.jsx` for stdio: _Own command_ (today's fields) or
  _Install package_ (registry, package name, version dropdown, program, "allow install
  scripts / source builds", arguments, env, cwd).
- **Version dropdown:** fetched once registry and name are set; latest stable preselected;
  newest first with date; prereleases behind a toggle; deprecated/yanked marked but
  selectable with a hint; unknown package or unreachable registry shows a message, not an
  empty list; on update the installed version is marked.
- **Preview and confirmation:** a new `McpPackageConfirmation.jsx` shows package, version,
  source, integrity, dependency count (expandable list), programs, and when scripts or
  builds are allowed a prominent warning that package code runs with the owner's rights.
- **Job status** in `McpServerDetail.jsx`: installing (progress), ready, failed (message
  for the error code, log tail). Binding controls stay disabled until ready.
- **Update:** version dropdown plus lock diff (added, removed, changed) before
  confirmation.
- **Reinstall** button when the install is missing or its receipt check fails.
- All copy in `web/lib/i18n/de/` and `web/lib/i18n/en/` with matching keys; backend
  messages in `server/lib/i18n/de/`.

## Error codes

`MCP_PACKAGE_INVALID`, `MCP_PACKAGE_NOT_FOUND`, `MCP_PACKAGE_VERSION_NOT_FOUND`,
`MCP_PACKAGE_REGISTRY_UNAVAILABLE`, `MCP_PACKAGE_NEEDS_SCRIPTS` (the form then offers
the opt-in), `MCP_PACKAGE_INTEGRITY_MISMATCH`, `MCP_PACKAGE_FOREIGN_SOURCE`,
`MCP_PACKAGE_NO_PROGRAM`, `MCP_PACKAGE_PROGRAM_REQUIRED`,
`MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE`, `MCP_PACKAGE_DOWNLOAD_FAILED`,
`MCP_PACKAGE_INSTALL_FAILED`, `MCP_PACKAGE_PREVIEW_EXPIRED`, `MCP_PACKAGE_BUSY` (409).
Downloads retry and honour the proxy like the runtime. A failed update leaves the
previous install active.

## Security model

- Only the two public registries; no other source anywhere in the lock.
- Without the opt-in no package code runs during install; with it, code runs with the
  service user's rights inside the same isolation (private `HOME`, `TMPDIR`, cache,
  empty config, minimal `PATH`). The owner's `~/.npmrc`, `pip.conf` or `uv.toml` never
  apply, so their tokens are not exposed.
- The install directory is owned by the service user; the server process only needs to
  read it. On every start AgentPier checks that the active install matches its receipt.
- At run time the server has exactly the rights of a hand-entered command today: the
  Gateway environment for agents, nono with the read grants above for CLIs.
- Audit entries: install, update, reinstall, remove with registry, name, version,
  scripts flag; never env values.

## Testing

- **Unit:** package-spec validation, registry metadata parsing (prerelease, deprecated,
  yanked, missing wheel), program selection, lock checks and diff, command generation,
  nono grants, error mapping.
- **Integration** against local fake registries (no network in CI): install, update with
  diff, failed update keeps the old install, reinstall from lock, removal, refused
  scripts, integrity mismatch, foreign source, an install-script package that writes
  nothing without the opt-in and runs with it.
- **Toolchains:** manifest checksum tests for all four targets; a native provisioning
  case in the Linux/macOS CI matrix.
- **Browser (Playwright, Chromium and WebKit):** source switch, version dropdown,
  preview, confirmation with warning, progress, update diff, in English and German.

## Manual qualification

Each server is bound to one agent and to Claude Code, and a real tool call succeeds.
Results go to a new `docs/mcp-package-qualification.md`.

- npm: `@modelcontextprotocol/server-memory`, `@modelcontextprotocol/server-filesystem`
  (with an allowed directory argument).
- PyPI: `mcp-server-time`, `mcp-server-fetch`.
- OPNsense: the read-only server by lucamarien against the owner's OPNsense with a
  restricted API user, bound to the network architect agent. Package name and the
  read-only code path are reviewed before installing.
- Opt-in path: one package that genuinely needs an install script or a source build.

## Delivery

1. **Toolchains:** `toolchains.js`, manifest, provisioning in `scripts/setup.sh`, the
   update path and on demand; docs in `docs/installation.md` and `docs/linux.md`.
2. **npm packages end to end:** registry metadata, preview, install, update, reinstall,
   store and form changes, nono grants, backup, docs in `docs/mcp.md`.
3. **PyPI packages** plus the manual qualification including OPNsense and
   `docs/mcp-package-qualification.md`.

## Open questions

1. **Python download verification:** confirm that `uv python install` verifies the
   CPython archive against a checksum embedded in the pinned `uv` release. If it does
   not, AgentPier pins the python-build-standalone asset and its SHA-256 itself and
   passes the verified file to `uv` (for example through `--mirror` pointing at a local
   directory).
2. **Python version:** which CPython minor to pin (proposal: the newest 3.x that the
   qualification servers support); servers whose `requires_python` excludes it fail
   with `MCP_PACKAGE_INSTALL_FAILED`.
3. **Linux libc:** the uv `gnu` builds assume glibc; whether any supported Linux target
   needs the `musl` build (`docs/linux.md` lists only x64 and arm64).
4. **Detecting `needsScripts` for Python:** the preview can only report a missing wheel
   reliably after a `--only-binary :all:` resolution attempt; the exact signal from
   `uv pip compile` needs to be confirmed.
5. **Node sharing:** whether the Node toolchain should later replace the copy inside the
   OpenClaw runtime directory (out of scope here; both stay separate).
