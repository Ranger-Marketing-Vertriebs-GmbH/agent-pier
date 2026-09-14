# Maintaining installer distribution

AgentPier publishes a source-only installer bundle and a standalone shell entrypoint
alongside the four application release packages. Homebrew manages the installer,
Git, and tmux. AgentPier manages its application releases, data, service, updates,
and rollback independently of Homebrew.

## Release artifacts

The release workflow builds:

- `agentpier-{darwin,linux}-{arm64,x64}.aprelease` and `latest.json`.
- `agentpier-installer-<version>.tar.gz`, containing tracked installer source and
  a plain-text `installer-version` file, without node_modules or user data.
- `install-agentpier.sh`, pinning the installer bundle URL and SHA-256.
- `installer.json`, recording bundle/script version, size, and SHA-256.
- `agentpier-installer.rb`, generated from the verified bundle metadata.

The installer package builder reads tracked source paths from Git; commit or stage
new installer source before building. It normalizes archive timestamps, ownership,
and modes. The application and installer versions must match when publishing.
The initial application download is pinned to that version, while subsequent
application updates continue to use the configured latest channel.

Local packaging does not install or start AgentPier:

```sh
node scripts/installer-package.mjs /absolute/output-directory
node scripts/homebrew-formula.mjs /absolute/output-directory
```

Tagged CI builds all platform packages, validates the complete asset set, creates
or resumes a draft, uploads missing assets, downloads and verifies their contents,
and only then publishes. `workflow_dispatch` only produces workflow artifacts.
Channel timestamps use the source commit date so retrying the same build does not
change `latest.json` merely because time elapsed.

An existing draft is reused only if its existing expected assets match. A published
release is verified but never overwritten. Failed uploads leave a draft and fail
CI. Fix the cause and rerun; do not delete or replace a published version to repair
installer metadata. Publish a new version when released content needs a fix.

## Initial tap provisioning

The planned public repository is
`Ranger-Marketing-Vertriebs-GmbH/homebrew-tap`. Provision it separately from local
implementation; until it exists and a formula is merged, the Brew command is not
available.

1. Create a public repository with default branch `main` and the Apache-2.0 license.
2. Copy `packaging/homebrew/verify.yml` into its `.github/workflows/verify.yml`.
   Add a README explaining `agentpier-install`, app-owned updates, and installer-only
   uninstallation. Bootstrap these repository files before enabling branch protection.
3. Protect `main`; require the two formula CI jobs and resolved review conversations.
4. Give release automation a credential scoped to this tap, with Contents and
   Pull requests read/write permissions. It does not need access to user accounts,
   profiles, or runtime data. Store it in the AgentPier repository as the Actions
   secret `HOMEBREW_TAP_TOKEN`; never commit or print it.
5. Set the Actions repository variable `AGENTPIER_HOMEBREW_TAP_ENABLED` to `true`.
6. Publish a new supporting AgentPier release. The tap job checks out the tap and
   proposes `Formula/agentpier-installer.rb` on a version-specific branch. Review the
   PR and merge only after formula installation, audit, and tests pass on Intel and
   Apple Silicon.

The normal updater edits only the formula, not tap workflows. Its credential therefore
needs no workflow-write permission. The first workflow installation is a separate
repository-maintainer action. The automation never pushes directly to `main` or
merges a PR. If an open PR already exists for that version, it returns its URL;
inspect the existing PR rather than silently changing its reviewed contents.

If a tap job fails after the app release publishes, the standalone installer remains
usable and the tap stays on its previous installer. Rerun the failed tap job after
repairing its configuration. Existing AgentPier installations can still update
through Settings; an older installer does not downgrade them.

## Acceptance before advertising

The generated formula has a real Homebrew `test do`; repository tests also execute
its wrapper through a small Ruby harness. Ruby is needed for this development test,
not for the installed AgentPier runtime. CI macOS/Linux runner images provide it.
The harness does not replace `brew audit` or actual Homebrew installation.

Use isolated macOS systems/users for launchd, first-install Homebrew prompts, and
native application smoke tests. Never run acceptance setup against the developer's
real AgentPier data, its service label, or the default tmux server. Follow the
[verification record](research/homebrew-install-verification.md) and record missing
platform/environment coverage explicitly.

The standalone URL follows GitHub's latest published release once. The downloaded
script then uses immutable version URLs and checksums. A custom installer domain,
Linux online setup, app upgrades through Brew, and a native `.app` bundle are outside
this delivery.
