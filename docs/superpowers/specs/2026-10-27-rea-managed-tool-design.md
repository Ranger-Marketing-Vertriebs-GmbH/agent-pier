# REA as a managed tool with selectable components (AGENTPIER-104)

## Intent

REA (`rea-agents`, MCP server `io.github.morluto/rea`, a reverse-engineering
toolkit) only works well with analysis tools next to it: Ghidra with a JDK, Frida,
Python helpers. Today the owner has to set those up by hand in a shell, on the host
or inside an AgentPier session. AgentPier should install REA like it installs nono, gh,
the managed agent browser and the managed GitHub MCP server: one place, pick the
components, AgentPier downloads pinned and verified builds, wires the environment,
registers the MCP server, and keeps it updated. No shell work.

The ticket text (Plane AGENTPIER-104) is the owner's requirement; this document
settles its open questions.

## Goals

1. An install dialog for REA with components:
   - **Core** (required): `rea-agents` at a pinned version, installed with the pinned
     Node toolchain and a frozen lockfile through the existing MCP package path
     (`server/features/mcp-packages/`), plus the skill `reverse-engineer-anything` at
     the same version through the package-skill path (AGENTPIER-102,
     `package-skills.js`).
   - **Ghidra with native decompiler** plus the **Temurin JDK** it needs (one
     component). The official Ghidra zip ships the decompiler only for linux-x64 and
     Windows (verified for 12.1.4), and REA rejects Ghidra without it. *(Owner
     decision:)* AgentPier downloads Homebrew's prebuilt Ghidra bottle (built with
     `gradle buildNatives`) directly from Homebrew's bottle registry (ghcr.io), pinned
     by version and SHA-256, **without running `brew`**, on macOS arm64 and Linux
     arm64/x64. Version: 12.1.4 with JDK 21 if Homebrew's bottle for it is still
     downloadable; otherwise the current bottle (12.2, JDK 25) only after a spike shows
     REA works with it. Intel Macs (no bottle): the component is unavailable with a
     clear reason. The bottle's Homebrew launcher scripts are not used; REA gets
     `GHIDRA_INSTALL_DIR` pointing at the bottle's `libexec` and our own `JAVA_HOME`.
   - **Frida**: REA loads the npm Node binding `frida` (an optional dependency of
     rea-agents), not Python `frida-tools`. AgentPier downloads frida's pinned,
     checksummed N-API prebuild from frida's GitHub release into the package's
     `node_modules/frida/build` instead of running frida's install script. Core itself
     installs with install scripts off.
   - **Bring your own** commercial tools, never downloaded: Hopper as a path field
     (`HOPPER_LAUNCHER_PATH`); IDA as the path to an IDA MCP bridge config JSON
     (`REA_IDA_MCP_CONFIG`); JEB as the URL of the owner's JEB MCP client
     (`REA_JEB_MCP_URL`). An analysis-provider choice Ghidra (default) / IDA sets
     `REA_ANALYSIS_PROVIDER`.
   - No pwntools helper in this version: REA verified it only on linux-x64 and its
     pinned unicorn has no wheels for our Python 3.14 or macOS arm64. Follow-up ticket.
2. Each downloaded component is pinned with version, URL, size and SHA-256 per
   platform (`darwin-arm64`, `linux-x64`, `linux-arm64`; `darwin-x64` only where an
   artifact exists), installed under the data dir, verified before unpacking, like
   `chromium-manifest.js` / `github-mcp-manifest.js`.
3. Install, update and uninstall per component, with status like the other managed
   tools (installed version, update available, remove).
4. AgentPier registers REA itself as an MCP server row with a new origin `managed`
   (today only `manual`, `paste`, `directory` exist, `server-origins.js`; the managed
   GitHub MCP binary for agents is not such a row, so this is new). Its command and
   the managed environment keys are locked; the owner may add own environment keys,
   which survive component changes. Managed environment: `GHIDRA_INSTALL_DIR`,
   `JAVA_HOME`, `REA_MCP_INPUT_SCHEMA_PROFILE=compact`, and the bring-your-own
   variables above. Changing components updates it. Deleting the row is done through
   the REA card's uninstall (which removes Core); the row itself offers no plain
   delete. A REA server the owner already added from the directory stays untouched.
   *(Claude's calls.)*
5. The owner binds the managed server to CLIs and agents as with any MCP server.
   Default on first install: bound to Claude Code (owner's ticket). The skill
   `reverse-engineer-anything` is copied automatically to the accounts REA is bound
   to, with the existing ownership tracking of package skills *(Claude's call)*.
6. rea-agents' lockfile ships with AgentPier (committed, reviewable), so every host
   installs the same dependency tree and the server-start update needs no registry
   resolve *(Claude's call)*.
7. Provisioned through install and update paths, never by hand: the installers get an
   option like `--with-agent-browser` (e.g. `--with-rea`), and an AgentPier release
   that raises a pinned version updates installed components at the next server start,
   like `ToolInstaller.keepChromiumCurrent`.

## Spike result (2026-10-27, this Mac, macOS 26 Tahoe arm64) — binding pins

- REA works end to end: `rea doctor --provider ghidra` healthy (native decompiler
  accepted), `rea decompile` of a small C binary succeeded in 6 s.
- **Pins:** Ghidra **12.1.4** (JDK 21; 12.2 is not needed), Temurin **21.0.13+9**,
  rea-agents **6.8.0**, frida **17.23.2** (N-API prebuild `napi-v8`).
- **Ghidra per platform** *(Claude's call from the spike)*:
  - darwin-arm64: Homebrew bottle 12.1.4 from ghcr.io — `arm64_sequoia`
    (sha256 `fdaf330d…6ca2`, 464278484 B) and `arm64_tahoe` (`d2a62223…0a9a`,
    464260893 B); pick by macOS version, newer macOS falls back to the tahoe bottle.
    Decompiler links only system libraries, ad-hoc signed; use `libexec` as
    `GHIDRA_INSTALL_DIR`, ignore Homebrew's launcher scripts.
  - linux-x64: the **official Ghidra 12.1.4 zip** (ships `linux_x86_64` natives), not
    the bottle — Homebrew's Linux bottles need Homebrew's ELF interpreter and glibc ≥
    2.38.
  - linux-arm64 and darwin-x64: Ghidra unavailable with a clear reason for now.
- **frida**: the prebuild is one file, placed at
  `node_modules/frida/build/frida_binding.node`; rea-agents installs with
  `--ignore-scripts`.
- **REA environment**: AgentPier starts REA with a controlled environment (its own
  HOME/TMPDIR, no inherited `CLAUDE_CONFIG_DIR`); REA otherwise reads the CLI's config
  directory. `rea doctor` will report `registration`/`skill` "config_drift" because
  `rea setup` is never run — expected, not shown as an error.
- **Sizes**: download ≈ 700 MB, installed ≈ 1.36 GB (Ghidra 767 MB, JDK 335 MB,
  rea-agents incl. frida 257 MB).

## Non-goals / anti-goals

- Never run `rea setup`: it writes into the CLI files AgentPier manages.
- No downloads of Hopper, IDA or JEB.
- No sandbox (nono) support for REA. AgentPier shows clearly which REA features need
  an unsandboxed session (owner decision in the ticket; also the owner's general rule:
  if something does not work in the sandbox, say so clearly).
- No generic "tool bundle" framework for future tools *(Claude's call)*. Build the
  REA component model small and local; generalise when a second bundle exists.
- No Linux distribution packages and no `brew install` *(owner decision)*: pinned
  downloads on both OSes, so versions and checksums are the same everywhere, `brew
  upgrade` cannot move them, and no administrator rights are needed.
- No pwntools/Python helper component in this version.

## Decided details

- **Where it appears** *(Claude's call)*: as a card next to the managed agent browser
  and the other managed tools (dashboard / Settings → Tools, wherever nono, gh and
  Chrome for Testing appear today), with the install dialog opened from there. The
  existing REA hint in the MCP directory (`curated-hints.js`, AGENTPIER-103) links to
  this managed install instead of only explaining the manual path.
- **Disk size**: the dialog shows each component's download and installed size
  (Ghidra + JDK about 1 GB) and the total before installing.
- **No remote install scripts**: neither frida's install script nor any other runs;
  every binary comes from a pinned, checksummed download.
- **JDK**: Temurin (21, or 25 if Ghidra 12.2 is used) from Adoptium's release
  archives, checksums from Adoptium's published `.sha256.txt` verified once when
  pinning. **Ghidra**: Homebrew bottle from ghcr.io, SHA-256 from the formula's bottle
  block (verified against the download when pinning).
- **Spike first**: before building, a spike in a separate AgentPier instance with its
  own data dir (never the live service) installs the bottle, JDK and frida prebuild on
  this Mac and runs REA's own checks plus one decompile, to settle the Ghidra version.
- **macOS quarantine and verification**: as for the managed browser (clear xattrs,
  check the version the binary reports after install).
- **Removal**: refused while a session or agent uses the managed REA server, with the
  reason, like the managed browser's 409.
- **Safety copy** in the dialog and docs: dual use; REA's DISCLAIMER forbids DRM,
  licence-check and anti-cheat circumvention; untrusted binaries belong in a VM or a
  separate account; only `morluto/rea` is genuine.
- de + en copy for everything new, confirmed with `npm run i18n:confirm`.

## Left to the builder

- Exact pinned versions at implementation time (verify upstream releases and
  checksums on the day, record the date in the manifest comment).
- File layout under `server/features/tools/` and the data dir path
  (follow `<data>/clis/.packages/<name>-<id>` with an atomically switched link).
- How the managed MCP server registration reuses the managed GitHub MCP server code
  (`github-mcp-installer.js`, `github-mcp-tool.js`).
- Which REA features need an unsandboxed session: derive from REA's docs and a real
  check; list them in the UI and in `docs/sandbox.md`.

## Tests and docs

- Unit tests: manifest platform selection, checksum/size mismatch refusals, archive
  unpack safety (reuse the browser installer's checks), environment derivation from
  installed components, removal refusal while in use, update at server start.
- Integration test with local fixture archives (never real downloads in CI).
- A spike install on this Mac with real downloads in a separate AgentPier instance
  with its own data dir (never the live service), reported in the PR.
- Browser test for the install dialog (component selection, sizes, safety copy, one
  run in English).
- Docs: `docs/mcp.md` (REA section), `docs/mcp-package-qualification.md` if REA's
  qualification changes, `docs/installation.md` and `docs/linux.md` for the installer
  option, `docs/sandbox.md`, README/README.de feature lists.
