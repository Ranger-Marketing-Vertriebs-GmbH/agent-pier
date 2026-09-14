# Installer verification record

Implementation verification uses disposable directories and fake package-manager/
service boundaries. No test targets real AgentPier profiles, the default tmux server,
or the developer's login service.

## Local evidence

Verified during implementation on native Apple Silicon macOS:

- Existing installer baseline: 41 focused tests passed before changes.
- Shared setup/preflight: 46 focused tests passed, including temporary Node reuse,
  argument boundaries, root/relative/unnormalized paths, native architecture, and
  nonstandard Homebrew paths.
- Online package/formula tests cover independent extraction, reproducible bytes,
  exclusion of untracked files, checksum and transfer failure, rejected USTAR
  extensions, truncated gzip, and the real generated Ruby wrapper with a prefix
  containing spaces.
- The actual source-only installer bundle was extracted outside the checkout.
  `setup.sh --help` and `--version` ran without node_modules.
- With a disposable HOME, a deliberately unavailable system Node, and fake Git/tmux
  executables, the extracted low-level installer downloaded the official pinned
  Node 22.22.2 runtime, verified it, and completed `--dependencies-only` with
  `installedDependencies: []`. No package manager or service was changed.
- The actual `.aprelease` was installed into disposable paths through the shared
  resume core with service inspection isolated. Repeating setup preserved the
  version. Its stable launcher started the real bundled server on an unused local
  port; `/api/health` confirmed AgentPier 1.17.0. The child was then terminated and
  its data removed. No login service was registered.
- Homebrew `brew style` inspected the generated formula with no offenses.
- `npm run check` passed: lint, formatting, structure, build, and 1,361 backend tests
  passed, with two existing skips.
- `npm run build` completed. The real macOS arm64 `.aprelease` builder completed its
  relocated smoke test, importing native terminal support, SQLite, and the server
  under the bundled runtime.
- Publication tests exercise interrupted draft uploads, divergent existing drafts,
  immutable published releases, missing/changed assets, manual dispatch guards,
  preservation of a newer latest channel, and tap retries after a merged PR.

The Ruby harness evaluates formula installation and executes its wrapper. It is not
an actual Homebrew installation or audit. The fresh-Node experiment exercises a
real runtime download with isolated dependencies; it is not a fresh macOS machine.

## Required system acceptance before advertising availability

| Scenario                                                            | Required environment                                    | Status                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Homebrew bootstrap and administrator/Command Line Tools prompts     | Fresh macOS 14+ native Apple Silicon                    | Not run                                                                 |
| Complete online and Brew installation                               | Fresh native Intel macOS                                | Not run                                                                 |
| Formula installation, audit, help/version tests                     | Published release and tap, both architectures           | Tap CI prepared; not run                                                |
| Login autostart, owned listener detection, and service repair       | Disposable logged-in macOS user/VM                      | Not run                                                                 |
| In-app update and compatible rollback with old helpers still usable | Disposable installed service and named test tmux server | Existing automated release tests; real login-service acceptance not run |
| Public one-liners                                                   | First supporting GitHub release and merged tap formula  | Not published by this implementation                                    |

Run the same setup twice, update the application through Settings, and rerun the old
installer. Confirm the active application version and private data remain unchanged.
Then stop only the disposable service and verify matching-service repair. Exercise
occupied-port/foreign-service cases without terminating the occupying process.
Repeat with custom paths containing spaces and interruption at installation phases.

For release automation and tap provisioning, use
[the maintenance guide](../homebrew-maintenance.md). Public availability requires
those external steps; a successful local build does not establish it.
