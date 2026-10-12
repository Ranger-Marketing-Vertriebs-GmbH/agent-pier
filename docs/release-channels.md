# Stable and Preview releases

The default Stable channel uses the official latest release manifest. Preview
uses the public GitHub release list and considers stable tags (`v1.29.0`) and
numbered release candidates (`v1.29.0-rc.1`). Drafts, alpha/beta tags and entries
without an uploaded `latest.json` are excluded. Candidates are compared by
semantic version, not publication date. The selected manifest and package are
loaded from the version-specific tag; the usual checksum and runtime checks apply.

Preview scans up to ten pages of 100 releases and fails explicitly if this limit
is exceeded. API failures leave the check unsuccessful rather than claiming that
no update exists. Stable checks do not require the release-list API.

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

## Installation preference

The choice is stored in `operations/release-preferences.json` inside the private
data directory. New installations default to Stable. Changing the channel clears
the checked offer and invalidates in-flight checks and staging downloads. It does
not activate a release, downgrade an installation, or delete already staged
packages. Existing rollback compatibility checks continue to apply.

`AGENTPIER_RELEASE_CHANNEL` remains a custom manifest source override. A custom
source disables the official Stable/Preview selector and retains its existing
version-selection behavior.
