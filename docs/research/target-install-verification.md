# Target installation verification

This report records the authorized installation on a macOS ARM64 Mac mini and checks performed by the coordinating agent. It deliberately omits hostnames, addresses, usernames, private keys, tailnet names and authentication URLs. The overall feature goal remains open until final browser/CI and live-provider verification are complete.

## Installation and remote access

The reusable `sh scripts/install.sh` release path completed successfully on the target after two defects found during actual packaging/deployment were corrected. Its explicit dependency option installed missing tmux. Its service option installed the user web service and confirmed the running release through `/api/health`. The target uses the packaged Node 22.22.2 runtime and a separate stable application data directory.

A dedicated Tailscale identity was authenticated and configured with private HTTPS Serve on port 443. The existing host identity was preserved. A real HTTPS request from the MacBook to the target's `/api/health` succeeded. This was an actual network/target check, not a mocked response or a local-only health probe.

No source account or secret migration was performed. The target is a fresh installation rather than a copy of an active local workspace.

## Native process and diagnostic checks

A new owned shell session on the target accepted a controlled input marker. The session remained alive and usable after restarting only the web service. The owned session was then stopped/deleted as part of cleanup. Existing user sessions and projects were not used for this test.

Target Doctor checks passed for the bundled Node 22.22.2 runtime, native PTY dependency, tmux, Git and the checked databases. Codex, Claude Code and OpenCode are all absent on the target at this stage. Their installation and account/provider configuration await the user; this report does not claim a target coding-agent or model invocation.

## Defects reproduced and corrected

1. **Package output through macOS aliases.** The strict private-directory helper rejected `/tmp` as an artifact parent. The builder now creates and smoke-checks the archive in private staging, resolves the declared existing output parent and publishes without changing that parent's permissions. Tests also reject output links and preserve previous output on failed smoke. The real package command succeeded and left `/tmp` at mode `1777`.
2. **Silent executable no-op through symlinks.** Node canonicalized the module URL while its entry argument retained a symlinked checkout path, so the installer exited successfully without running its main function. The shared `isMainModule` helper now resolves both identities. All 13 affected script/native-helper guards preserve their extra argument requirements, and imports remain inert. Five new identity/subprocess tests and the 72-test affected suite passed. Independent review found no blocker. A fresh real package passed its production dependency installation and relocated runtime smoke before the installer was retried successfully.

The target service and remote checks above were performed after these corrections. Synthetic update/rollback survival and schema restrictions are documented separately in the [operations report](../refactor/operations-worker-report.md); this installation does not claim a live upgrade or rollback between two target versions.

## Final verification and remaining account setup

The final source check passed lint, formatting, the structure gate, production build and622/622 backend tests. Full local browsers passed152 Chromium and150 WebKit tests, with two documented platform-specific worker automation skips. All six [CI jobs](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34104907021) and all four [release-package platforms](https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/actions/runs/34104920938) passed for7988ed5.

Small real local provider results are recorded in [live-provider-verification.md](live-provider-verification.md). The remaining account question concerns the regular Z.ai API balance rejection in OpenCode. Target coding CLI installation and account setup remain with the user as planned; credentials were not migrated. Physical-device push delivery is not inferred from controlled transport/browser tests.

## Versioned update verification

Version1.0.1 was staged from a fresh checksum-protected ARM64 package, then activated through the production HTTP operation job. The external helper completed successfully across the web-process replacement. A new owned shell session survived the update and accepted another command afterward; it and its temporary directory were removed. The prior immutable1.0.0 release remains installed. Authenticated private HTTPS health reports1.0.1 without operational warnings.
