# Homebrew and standalone installation

Status: proposed design for review; implementation has not started.

## Goal and agreed scope

A new macOS user can install the prerequisites, AgentPier, and its login service
with one terminal command. Provide both a Homebrew entrypoint and a standalone
download entrypoint in the first delivery. Both use one installer implementation.
AgentPier continues to own application updates and compatible rollback through
Settings. Application upgrades through `brew upgrade` are outside this delivery.

Target native Apple Silicon and Intel macOS. Preserve the existing Linux installer
and release jobs, but do not advertise the new online entrypoint on Linux until it
has its own end-to-end acceptance. Require macOS 14+ initially; verify downloaded
runtime and native modules on the declared minimum before publishing support.
Detect and reject a translated x64 shell on Apple Silicon with instructions to use
a native terminal, instead of silently mixing architectures or Homebrew prefixes.

The standalone command is part of the core work, not a later enhancement. It needs
additional packaging, download, terminal-input, and failure-path coverage; it does
not require a separate installation engine.

## Current implementation and constraints

- `scripts/install.sh` bootstraps Node when needed and delegates to
  `scripts/release-install.mjs`, but requires sibling source files.
- `scripts/install-dependencies.mjs` installs missing Git/tmux, including Homebrew
  bootstrap on macOS. `--dependencies-only` is the existing repair path.
- `scripts/release-package.mjs` produces `.aprelease` files containing the web build,
  server, production dependencies, and a pinned official Node runtime. `.aprelease`
  is gzip-compressed JSON, not a tar archive; the shell cannot extract it with tar.
- `.github/workflows/release.yml` builds four platform artifacts and publishes a
  versioned release plus `latest.json` after tag/version validation.
- `scripts/service.mjs` and `release-service.js` use `dev.agentpier.server`.
  Retain that service owner; adding a competing Brew service would break restarts.
- The active release is an atomic `current` symlink. Old release paths must survive:
  running sessions can still reference their hook/MCP programs.
- The low-level installer currently rejects an existing `current`. A user-facing
  retry path must therefore be added deliberately, without silently upgrading it.

## Chosen architecture and alternatives

Choose a Homebrew formula for the **installer**, plus the same installer delivered
as a standalone shell download. Homebrew owns installer files and Git/tmux; AgentPier
owns application releases, private data, and its user service outside Homebrew.

A full application formula would require a different update policy and resolving
old-release removal by Brew cleanup. A standalone-only installer would omit the
requested Brew entrypoint. Neither is the selected first delivery.

Use `agentpier-installer` as the formula name and `agentpier-install` as its command.
The different name makes package ownership explicit. Its version identifies the
installer distribution shipped with a release, not the currently running app.
Upgrading/reinstalling that formula must never activate or downgrade AgentPier.

## Intended user commands

These are proposed public commands and must not be advertised as available yet.
The planned tap repository is
`Ranger-Marketing-Vertriebs-GmbH/homebrew-tap`.

```sh
brew install ranger-marketing-vertriebs-gmbh/tap/agentpier-installer && agentpier-install
```

Without Homebrew already installed, use the release-hosted shell entrypoint. Download
to a private temporary file and execute only after curl exits successfully; preserve
stdin for package-manager prompts. The final documentation should publish this
single line, with the actual asset available and verified first:

```sh
(agentpier_tmp=$(mktemp -d) && trap 'rm -rf "$agentpier_tmp"' EXIT && curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/latest/download/install-agentpier.sh -o "$agentpier_tmp/install.sh" && /bin/sh "$agentpier_tmp/install.sh")
```

macOS supplies curl and the shell for the initial download. This command cannot
bootstrap curl on a machine where it is absent. Homebrew's normal administrator
and Command Line Tools prompts may appear; never promise unattended installation.

Both routes start the service, wait for health, and print `http://127.0.0.1:4380`
and the installed version. Do not automatically open a browser or configure remote
access. Account creation and provider authentication remain in the existing UI.
Coding CLIs and optional Tailscale remain separately installable as today.

## Shared entrypoint and package

Add `scripts/setup.sh` as the user-facing entrypoint around `scripts/install.sh`.
It supports `--help`, `--version`, `--no-service`, `--install-root`, `--data-dir`,
`--skip-dependencies`, and `--dependencies-only`. Unknown or conflicting arguments
fail before downloads, Node probes, or package-manager calls. Help/version do not
install anything. Keep existing low-level install flags and their behavior intact.

Default application root: `$HOME/.local/share/agentpier-app`.
Default data directory: `$HOME/Library/Application Support/AgentPier`.
Explicit CLI paths win over `AGENTPIER_INSTALL_ROOT`/`AGENTPIER_DATA_DIR`, which win
over defaults. Require absolute paths, a non-root user, and data outside the install
root. The high-level setup defaults to installing the login service; `--no-service`
installs files only. Do not change shell startup files or create a global app alias.
The existing stable launcher remains `<install-root>/bin/agentpier`.

Dependency-only repair forwards only dependency-repair flags to the low-level
installer; it does not create a receipt, resolve a release, or pass service/resume
flags. Support nonstandard Homebrew prefixes by locating Brew explicitly and passing
its bin/sbin paths into setup and the stored service PATH.

Produce `agentpier-installer-<version>.tar.gz` with the source dependencies needed
to run setup from a clean extracted directory, including `package.json`, `scripts`,
`server`, `vendor`, and license notices. Exclude Git metadata, data, attachments,
development dependencies, and built application artifacts. Initially copying these
explicit source directories is preferable to maintaining a fragile import closure.
Tests must prove no `npm ci`, checkout, or preinstalled Node is required.

Generate `install-agentpier.sh` with embedded release version, installer-bundle
SHA-256, and an immutable `/releases/download/v<version>/...` bundle URL. Resolve
latest only once, by downloading that script. Verify the bundle before extraction;
reject unsafe archive members/links and enforce download/extraction bounds. Then
run its `scripts/setup.sh` in the same terminal context and propagate the exit code.

Installer bundle limits are 16 MiB compressed, 64 MiB expanded, and 10,000 members;
the generated shell asset is limited to 256 KiB by publication validation. The
packager enforces the same limits and uses only regular files and directories.
Keep application archive limits in the existing release implementation unchanged.

The bundle includes release version metadata. A new installation selects the
matching immutable release channel, verifies the platform `.aprelease` through the
existing release code, and installs it. The configured ongoing update channel must
remain the official latest channel; never persist the installation's pinned URL as
the update channel. Existing installs keep their configured channel and version.
Temporary Node bootstrapping continues to use the existing verified runtime path;
the installed app uses its release's own runtime.

HTTPS and checksums protect transfer integrity within the existing publisher trust
model. Do not describe them as independent publisher signatures.

## Retry, coexistence, and failure behavior

Add an explicit `--resume` capability to the low-level installer, used by setup.
Keep the low-level default rejection for existing installations for compatibility.

Before mutation, inspect the target paths, current launcher/release metadata, the
existing service configuration, and port 4380. A service using another root/data
directory, an unrelated listener, unknown nonempty target directory, or mismatching
installation receipt causes an actionable conflict. No silent adoption or migration
of a source checkout or an older installation without setup ownership metadata.
Tell users which configured paths to inspect; do not expose profile data.

Write a private, versioned installation receipt and acquire an exclusive setup lock
before staging. Record root/data paths, the first-install release target, and durable
phase transitions. On interruption, preserve verified releases and receipt state;
rerunning resumes the recorded target, even if latest changed in the meantime.
Validate the recorded phase against actual files; never trust the receipt alone.

For an already healthy, matching setup, return its actual active version and do not
download, switch releases, or restart the service. A stopped or missing matching
service can be restored. A retry after health failure retries service finalization
with the already selected release. `--no-service` neither starts nor repairs a
service. Reject a live setup lock; a dead-owner lock may be recovered only after
validating matching ownership and recorded state. An interrupted download is retried
in fresh temporary storage; never execute partial payloads.

Application/data files retain private permissions. Dependency repair remains
available for existing installations. Setup success requires the expected application
version and a service/listener belonging to this installation, not just an HTTP 200.
Do not terminate other listeners or real user sessions to make installation pass.

`brew uninstall agentpier-installer` removes only the installer. The application,
service, Git/tmux, and private data are separate; explain this in formula caveats and
installation docs. Document stopping/removing the AgentPier service separately and
explicitly preserving data. No automated destructive uninstall command in this scope.

## Release and tap delivery

Build and test the installer bundle and generated shell asset once per version,
alongside the four existing app packages. Publish a draft GitHub release, upload and
verify all required assets, and only then publish it so latest cannot point at an
incomplete installer. Retrying publication must handle a matching existing draft;
never overwrite immutable assets of an already published release.

Keep a formula template and deterministic generator in AgentPier. The generated
formula downloads the immutable source bundle with SHA-256, declares Git/tmux and
macOS prerequisites, installs into `libexec`, and exposes `agentpier-install`.
Formula installation never runs user setup, nested Brew installation, launchctl, or
network downloads beyond Homebrew's declared fetch. No `brew services` definition.

After release publication, propose the formula update in the tap using a dedicated
automation identity scoped to that repository. Tap checks include formula audit,
installation, and the help/version test. Merge only after its checks and review
requirements. If tap publication fails, the standalone installer remains available
and the tap remains on its last tested installer. Repository creation and credentials
are deployment prerequisites, not reasons to block local packaging and tests.

## Acceptance and implementation order

1. Shared setup policy and safe retry/finalization of installations.
2. Checkout-free source bundle and version-pinned online entrypoint.
3. Homebrew formula around that same source bundle.
4. Complete release publication and tap update automation.
5. Isolated system acceptance and public operating documentation.

Required acceptance includes native Intel/Apple Silicon; no Node/Brew/tmux/Git;
existing dependencies; spaces in paths; custom paths; permission failure; download
failure/checksum mismatch; unsupported OS/architecture; occupied port/service
conflict; repeat setup; interrupted setup; simultaneous setup; app update followed by
rerunning an older installer; dependency repair; and installer removal/reinstallation.
Verify an in-app update and compatible rollback while a disposable tmux session
continues to use its old-release helpers. CI must never use real sessions or the
default tmux server. Real launchd acceptance requires a disposable logged-in macOS
user/VM; hosted-runner shell tests alone do not prove login-service behavior.

Planning estimate: 3–5 developer days for both macOS entrypoints, packaging, retry
behavior, automation, and acceptance, excluding external credential/review wait.
The standalone wrapper itself is small; reliable clean-machine and retry coverage
accounts for most of the increase over the initial rough estimate.

## Sources

- [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook): formula dependencies,
  installation boundaries, tests, and service support.
- [Maintaining a tap](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap): separate
  distribution repository and formula testing.
- [Homebrew installation](https://docs.brew.sh/Installation): host prerequisites and
  official Homebrew bootstrap.
- Local `docs/installation.md` and `docs/research/operations-portability.md`:
  current installation paths, release ownership, and rollback constraints.

This is a temporary planning document. Remove it with the completed implementation
plan before opening the implementation PR; retain lasting operating guidance in
`docs/installation.md`.
