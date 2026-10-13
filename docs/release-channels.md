# Stable and Preview releases

The default Stable channel uses the official latest release manifest. Preview
uses the public GitHub release list and considers stable tags (`v1.29.0`) and
numbered release candidates (`v1.29.0-rc.1`). Drafts, alpha/beta tags and entries
without an uploaded `latest.json` are excluded. Candidates are compared by
semantic version, not publication date. The selected manifest and package are
loaded from the version-specific tag; the usual checksum and runtime checks apply.

Preview scans up to ten pages of 100 releases and fails explicitly if this limit
is exceeded. Each page response may be at most 4 MiB. The listing includes full
release notes; 100 releases currently take about 1.5 MB, so very long release notes
could later reach this cap and make the Preview check fail. API failures leave the
check unsuccessful rather than claiming that no update exists. An exhausted GitHub
API quota (60 unauthenticated requests per hour and IP address) is reported as a
rate limit. Stable checks do not require the release-list API.

## Publishing

1. Set `package.json` and `package-lock.json` to the candidate version, for example
   `1.29.0-rc.1`, on a release branch. Submit the change through a pull request and
   complete the required checks and review.
2. After merging, tag the corresponding commit `v1.29.0-rc.1` and push the tag.
   The existing release workflow builds all four platform packages and installer
   assets, verifies their checksums, then publishes a GitHub prerelease. It does
   not replace the latest stable release or update the stable Homebrew formula.
3. Select Preview in Settings → Updates on a test installation, check for updates,
   stage the candidate and activate it. Publish a new numbered RC for each revision;
   published assets remain immutable.
4. After testing, prepare the final version `1.29.0` through the same reviewed
   version-bump and tag process. The resulting stable release is offered in both
   channels and supersedes the RCs. Do not rename an RC tag or overwrite its assets.

A manual workflow dispatch only builds artifacts; publishing requires the tag push.
Existing installations first need a stable release containing the channel selector.

## Data schema rule for release candidates

Activating a release can migrate the private data directory to a newer data schema.
Every package declares the range of data schemas it can open (`schemaMin` to
`schemaMax`), and `latest.json` repeats that range.

- Once a schema version `N` ships in any published RC, it is frozen. The final
  release and every later RC of the same version must accept it:
  `schemaMin <= N <= schemaMax`. Do not rework or renumber a migration after an RC
  that contains it has been published.
- Avoid schema bumps in late RCs. Put migrations into the first RC of a version so
  that testers exercise them for the longest time.
- The publish step enforces this rule. Before it creates or publishes a release
  `x.y.z` or `x.y.z-rc.N`, it reads `latest.json` of every earlier published
  `x.y.z-rc.*` and fails if the new release does not accept that RC's `schemaMax`.
- Testers take a backup in Settings → Backups before they activate an RC that changes
  the data schema.

## Installation preference

The choice is stored in `operations/release-preferences.json` inside the private
data directory. New installations default to Stable. Changing the channel clears
the checked offer and invalidates in-flight checks and staging downloads. It does
not activate a release, downgrade an installation, or delete already staged
packages. A package staged from Preview therefore stays activatable after switching
to Stable, and the Updates page marks it as a pre-release.

Rollback is checked against the data directory. After an RC has migrated the data
to a newer schema, rollback to an older stable version that cannot open this schema
is refused. The installation stays on the RC until a release that accepts the schema
arrives, or the data is restored from a backup.

The command line follows the same saved, installation-wide choice.
`scripts/operations.mjs release-check` and `release-stage`, and `release-install`
without an archive, read the preference from the data directory. A reinstall that
reuses a data directory with Preview selected therefore installs the newest RC.
`--channel` sets a custom manifest source; it does not choose between Stable and
Preview. Select Stable in Settings → Updates first to stay on stable releases.

`AGENTPIER_RELEASE_CHANNEL` remains a custom manifest source override. A custom
source disables the official Stable/Preview selector and retains its existing
version-selection behavior.
