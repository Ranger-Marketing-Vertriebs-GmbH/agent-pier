# Homebrew and Standalone Installer Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan
> task-by-task after design review. Steps use checkbox syntax for tracking.

**Goal:** Ship Homebrew and standalone one-command macOS setup using one installer,
while keeping application updates and rollback inside AgentPier.

**Architecture:** Homebrew owns a source-only installer package and prerequisites.
The shared setup command installs versioned application releases and a user service
outside Homebrew. A generated online shell asset downloads the same installer bundle.

**Tech Stack:** POSIX shell, Node.js ES modules, node:test, Ruby Homebrew formula,
GitHub Actions, existing AgentPier release/runtime/service modules.

**Spec:** `docs/superpowers/specs/2026-09-14-homebrew-installer-design.md`

**Status:** Proposed execution sequence for the design above; no implementation or
external repository changes have been made.

## Global Constraints

- Native Apple Silicon and Intel macOS, macOS 14+ initially, tested at the minimum.
- Preserve existing Linux installer behavior and all four release artifacts.
- Application updates remain in AgentPier; Brew manages the installer only.
- Existing Node requirement remains 22.13+; reuse the pinned bootstrap/runtime policy.
- Application root defaults to `$HOME/.local/share/agentpier-app`; data defaults to
  `$HOME/Library/Application Support/AgentPier`. Data must be outside the app root.
- Keep service label `dev.agentpier.server` and retain old application releases.
- No real user sessions, default tmux server, live service changes, or profile data
  in tests. Use a disposable logged-in user/VM for real launchd acceptance.
- No implementation source/test file over 600 lines. Match existing ESM and style.
- Any browser-visible copy needs matching DE/EN catalogs, reactive exports, catalog
  parity coverage, and English UI verification. No new browser UI is planned.
- Feature branch/PR only; no protected-main push or merge before required checks.
- Plans/specs are temporary and must be removed before the implementation PR.

## Task 1: Shared user-facing setup policy

**Files:** Create `scripts/setup.sh`, `scripts/setup-options.mjs`,
`tests/unit/setup-options.test.js`, and `tests/integration/setup-entrypoint.test.js`.
Modify `scripts/install-bootstrap.sh` only to share shell validation where helpful;
retain the existing low-level CLI behavior.

**Interface:** Export `resolveSetupOptions(args, { home, env, platform, arch })` from
`setup-options.mjs`. Return `{ installRoot, dataDir, service, installDependencies,
dependenciesOnly, resume }`, with `resume: true` and `service: true` by default.
The shell handles side-effect-free help/version and validates inputs before invoking
the existing Node bootstrap. Do not require a working Node to ask for help/version.

- [ ] Add policy tests for defaults, CLI > environment > home precedence, absolute
      paths, outside-root data, unknown flags, and mutually exclusive options.

```js
assert.deepEqual(
  resolveSetupOptions([], {
    home: "/Users/fixture",
    env: {},
    platform: "darwin",
    arch: "arm64",
  }),
  {
    installRoot: "/Users/fixture/.local/share/agentpier-app",
    dataDir: "/Users/fixture/Library/Application Support/AgentPier",
    service: true,
    installDependencies: true,
    dependenciesOnly: false,
    resume: true,
  },
);
```

- [ ] Run `node --test tests/unit/setup-options.test.js` and observe missing-export
      failure before adding implementation.
- [ ] Implement the resolver and shell entrypoint. Read version from a bundle text
      metadata file in shell; never parse JSON with grep. Delegate actual installation
      to `install.sh` with resolved flags. Keep process arguments separately quoted.
- [ ] Build shell fixtures modeled on `installer-bootstrap.test.js`: fake executable
      tools append to a calls file. Assert help/version/invalid inputs never call
      Node, curl, Brew, sudo, or launchctl. Check `--no-service` and argument forwarding.
- [ ] Keep dependency-only repair free of release/root/resume/service arguments.
      Locate nonstandard Homebrew prefixes and preserve their tool paths through
      Node bootstrap and service configuration; cover with fake-prefix fixtures.
- [ ] Add preflight OS minimum, root-user, unsupported-architecture, and Rosetta
      rejection tests before adding those checks. Do not change the host.
- [ ] Run the two new suites and `tests/integration/installer-bootstrap.test.js`.
      Commit as `feat: add shared macOS setup entrypoint`.

## Task 2: Resume setup without changing installed application versions

**Files:** Create `scripts/setup-state.mjs`,
`tests/integration/setup-resume.test.js`, `tests/helpers/setup-fixture.js`.
Modify `scripts/release-install.mjs`, `scripts/install-bootstrap.sh`, and extend
`tests/matrix/operations-installer.test.js`. Reuse service/release modules.

**Interfaces:** Add `resume = false` and `initialChannel` to `installRelease` options.
Add low-level `--resume` and `--initial-channel` parsing. `initialChannel` affects
initial staging only, while the existing `channel` controls ongoing updates.
Create `inspectSetup({ installRoot, dataDir })` returning
`{ state, receipt, activeVersion }`, where state is `fresh`, `incomplete`, `installed`,
or `conflict`. Receipt schema 1 stores canonical paths, initial release version,
initial channel, and phase (`prepared`, `staged`, `selected`, `service`, `healthy`).
Use an exclusive `.setup.lock`; receipt changes are atomic and private.

- [ ] Create `setupFixture(t)` providing disposable real paths, a minimal valid
      `.aprelease` built like `operations-installer.test.js`, injected fake service/
      dependency/health calls, and a record of stage/restart calls. Register cleanup
      with `t.after`. No host package managers or launchctl in this fixture.
- [ ] Write the no-downgrade regression first: install fixture v1, move the fixture
      to a valid v2 current release, rerun v1 setup with resume, and assert:

```js
assert.equal(result.version, "2.0.0");
assert.equal(await fs.readlink(path.join(installRoot, "current")), "releases/2.0.0");
assert.equal(stageCalls.length, 0);
assert.equal(restartCalls.length, 0);
```

- [ ] Confirm the new suite fails on the current existing-install rejection.
- [ ] Implement receipt/lock validation before setup writes. Distinguish a matching
      healthy service from a stopped matching service or a conflicting service by
      inspecting configured launcher/data paths; HTTP health alone is insufficient.
      Store only installation metadata, never accounts or tokens.
- [ ] Add failure injection after every durable phase. Resume by reconciling actual
      verified artifacts with the receipt. Reuse a verified staged target rather
      than failing because its directory exists. Reject unknown nonempty roots and
      incompatible receipts without mutation. Preserve active versions and channels.
- [ ] Cover simultaneous setup, live/dead lock owners, corrupted receipts, changed
      paths, legacy installs without receipts, dangling current pointers, a foreign
      port listener, and no-service behavior. An incomplete setup must retain its
      original target even when the remote latest version advances.
- [ ] Verify missing dependencies still use `ensureDependencies`; skip-dependencies
      checks only. Keep ordinary low-level setup's existing rejection test intact.
- [ ] Run the focused command below. Commit as
      `feat: resume owned installations safely`.

```sh
node --test tests/integration/setup-resume.test.js tests/matrix/operations-installer.test.js tests/matrix/installer-dependencies.test.js
```

## Task 3: Checkout-free installer bundle and online shell asset

**Files:** Create `scripts/installer-package.mjs`,
`scripts/install-online.sh.in`, `tests/integration/installer-package.test.js`,
and `tests/integration/installer-online.test.js`.
Modify setup to consume packaged `installer-version` metadata and pass its immutable
initial channel to the low-level installer, while leaving ongoing updates on latest.

**Interfaces:** Export `buildInstaller({ source, outputDir, version })`, returning
`{ version, bundle: { file, sha256, bytes }, script: { file, sha256, bytes } }`.
Write the bundle, `install-agentpier.sh`, and `installer.json` into `outputDir`.
The shell template has generator-replaced version/digest constants, fixed official
host/repository, and a fixed versioned bundle URL. Validate constants before rendering.

- [ ] Write a packaging test that extracts the output to a temporary directory with
      no checkout or node_modules, invokes setup help and dependency-only fixtures,
      and verifies required relative imports work.
- [ ] Assert archive membership excludes `.git`, `.data`, `node_modules`, attachments,
      and arbitrary untracked files. Package an explicit allowlist of source roots;
      reject escaping source links. Include both license notice files.
- [ ] Run the packaging suite and observe failure before implementing the builder.
- [ ] Implement deterministic member ordering and fixed archive metadata so identical
      source inputs produce the same bundle hash. Ship `installer-version` inside.
- [ ] Add the shell template: check platform/options, create private temporary storage,
      fetch immutable bundle over HTTPS with redirect restrictions, require successful
      curl completion, verify embedded SHA-256, validate archive member types/paths,
      enforce size bounds, extract, and run setup. Preserve stdin and child status.
      Clean temporary files on success, failure, and interrupt.
- [ ] Enforce 16 MiB compressed, 64 MiB expanded, and 10,000 members in both package
      generation and extraction. Allow only regular files/directories. Bound the
      published generated shell asset to 256 KiB; preserve existing app archive limits.
- [ ] Test fake curl/tar/shasum paths for wrong checksum, incomplete transfer, redirect
      downgrade, escaping paths/links, oversized bundle, interrupted execution, and
      exact option forwarding. Assert setup is never executed on invalid downloads.
- [ ] Test no preinstalled Node using existing bootstrap fixtures, including missing
      Homebrew. Verify first-install artifact URLs stay on one version while service
      configuration keeps the latest update channel.
- [ ] Run both new suites and existing homebrew/installer bootstrap suites.
      Commit as `feat: package standalone online installer`.

## Task 4: Homebrew installer formula

**Files:** Create `packaging/homebrew/agentpier-installer.rb.in`,
`scripts/homebrew-formula.mjs`, `tests/unit/homebrew-formula.test.js`.
The deployed formula goes to `Formula/agentpier-installer.rb` in the planned tap.

**Interface:** Export `renderInstallerFormula({ version, file, sha256 })`, returning
Ruby source with fixed official repository download URLs. Consume Task 3's bundle
record. Require a valid release version, exact expected filename, and 64 hex digest.

- [ ] Write generator tests for immutable version URL, checksum, macOS minimum,
      Git/tmux dependencies, installer command, caveats, and rejecting injected input.
- [ ] Run the unit suite to establish failure, then implement generator/template.
      Install source contents into `libexec` and create a shell wrapper invoking
      `libexec/scripts/setup.sh` with all original arguments.
- [ ] Formula `install` only copies/wraps files; omit application setup, service DSL,
      post-install execution, npm install, and a global Node dependency.
- [ ] Add a real `test do` that runs `agentpier-install --version` and `--help` under
      Homebrew's isolated test HOME; assert matching package version and setup usage.
- [ ] Generate from a real local bundle and run Ruby syntax checks. In disposable
      macOS environments, serve the immutable bundle from a test release, then run
      `brew install`, `brew audit --strict --formula`, and `brew test` for the tap
      formula. Verify Brew installation alone starts no AgentPier process.
- [ ] Run setup separately with fixtures and verify it delegates to the same shared
      installer as the standalone route. Test installer reinstall/removal while a
      separate app installation remains intact. Do not uninstall shared host tools.
- [ ] Commit as `feat: add Homebrew installer formula generation`.

## Task 5: Publish coherent assets and automate the tap update

**Files:** Modify `.github/workflows/release.yml`.
Create `scripts/installer-release-check.mjs`,
`tests/integration/installer-release-publication.test.js`, and
`docs/homebrew-maintenance.md`. Add `.github/workflows/verify.yml` in the tap.

**Interface:** Installer release validation consumes `latest.json`, `installer.json`,
all four app artifacts, the installer bundle/script, and the generated formula.
It must reject missing files, digest mismatch, version/tag disagreement, and a
formula referencing anything other than the verified installer bundle.

- [ ] Add fixture tests for the complete asset set and each missing/mismatched asset.
      Run the new suite to fail before implementing validation.
- [ ] Add the installer build/test job, upload its artifacts, and require all jobs
      before publication. Keep workflow_dispatch as artifacts-only.
- [ ] Replace immediate publication with draft creation/reuse, asset upload,
      downloaded-asset verification, and final publication. Test gh orchestration with
      an injected command runner; no live releases during repository tests.
- [ ] Define retry behavior: reuse a matching draft; reject divergent assets or tags;
      treat an already published matching release as complete after verification and
      never replace its bytes. Existing historical releases lack installer assets and
      must not be relabeled as supporting the new entrypoints.
- [ ] After publication, use a repository-scoped automation credential to create a
      tap PR from generated formula content. Use structured body arguments or a body
      file, English title/description, and the source release link. No direct main
      push. The tap workflow audits/tests both native Mac architectures.
- [ ] Document tap creation, credential permissions, protected branch requirements,
      rerunning failed distribution, and the separation between installer/app versions.
      Prepare all local files before requesting any unavailable external provisioning.
- [ ] Run publication/generator suites. Commit as
      `feat: publish verified installer assets and tap updates`.

## Task 6: Acceptance and user documentation

**Files:** Modify `README.md`, `docs/installation.md`.
Create `docs/research/homebrew-install-verification.md` for reproducible acceptance
commands, environment versions, and observed results; do not include host identities.

- [ ] On disposable native Intel and Apple Silicon macOS, test the standalone path
      without Node/Brew/tmux/Git, then the Brew path with Homebrew available. Test the
      declared macOS minimum, native module loading, and a real isolated terminal.
- [ ] Use a disposable logged-in macOS user to verify launchd login/restart, correct
      PATH, version health, stopped-service repair, occupied-port rejection, and retry
      after failed health. Fake launchctl coverage is not a substitute for this step.
- [ ] In that isolated installation, update through Settings, verify a continuing
      named disposable tmux-server session and its old-release helper, perform a
      compatible rollback, and rerun the original installer without changing version.
- [ ] Exercise spaces/custom paths, preserved private data, setup interruption,
      dependency repair, and installer-only uninstall/reinstall. Record actual pass/
      failure results; do not mark unavailable environments as passing.
- [ ] Document both verified one-liners, supported systems, expected prompts, URL,
      account/CLI setup, app-owned updates, retries, and separate service removal.
      Label commands unavailable until their release/tap has actually been published.
- [ ] Run `npm run check`. Run catalog parity and affected English browser tests only
      if implementation introduces browser-visible copy. Do not add a new UI just
      to explain installation ownership; README and formula caveats cover this scope.
- [ ] Commit as `docs: document verified one-command installation`.

## Completion and release handoff

- [ ] Review implementation against every acceptance case in the spec. Report any
      missing external credentials or unavailable macOS acceptance environments as
      outstanding work, not successful completion.
- [ ] Move lasting decisions into installation/maintenance docs; remove this plan and
      its spec in the final cleanup commit before opening the implementation PR.
- [ ] Open an English PR with problem/result, test evidence, and publication steps.
      Resolve review conversations and wait for required CI before merging.
- [ ] Publish the first supporting release, pass tap checks, merge its formula PR,
      and verify both public entrypoints in disposable installations. Only then
      advertise the commands as working. Remove clean inactive implementation
      worktrees after merge, preserving unmerged or active work.
