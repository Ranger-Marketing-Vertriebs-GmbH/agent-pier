# Workspace follow-ups

User-approved implementation scope, September 7, 2026. Continue autonomously with English source, German interface text, at most 600 lines per source file, and isolated tests. Do not install CLIs globally on the development MacBook or change user projects/credentials. Mac mini deployment is authorized. Preserve live native sessions.

- [x] Ship initial terminal focus/login-input repair as 1.1.1; installed Mini activation succeeded and HTTPS health checked. This version's manual code form is superseded by the next requirement.
- [x] Change Claude account Sign in to the normal native TUI, removing the temporary manual-code field; retain account isolation and terminal focus repair. Local focused tests pass.
- [x] Implement read-only native Claude auth status with selected account environment; UI replaces Sign in with Signed in. Local focused tests pass.
- [x] Persist standard accounts per CLI, expose selection in account cards and apply on new native sessions. No copying credentials into the host profile. Backend/browser tests pass.
- [x] Default Claude and OpenCode session dialog to Auto and retain user-selected mode when changing account. Codex remains Standard; YOLO stays an explicit selection.
- [x] Prefer official native shell installers. Use server-user installation paths so native updates preserve their expected HOME, while retaining account-specific credential configuration. Never override runtime HOME merely to make updates work. Keep existing installs intact and document official mechanisms accurately.
- [x] Add folder creation to the shared directory picker with single child-name validation and no overwrite.
- [x] Searchable dropdowns for organizations and repositories, preserving remote search/pagination and public URL entry.
- [x] Reuse directory picker for repository clone destination.
- [x] Add project file explorer with bounded directory pagination, text/image preview, deep-linked path state and new folders. Limit explorer to the selected project root; do not add destructive operations.
- [x] Full integration/build/lint/structure and browser verification, self-review, package and deploy finished changes. Installed HTTPS routes, native auth status (metadata only), session preservation and the local instance checked.

Two workers began account defaults and native-installer research but stopped due their usage limit. Root owns their remaining work. Account backend edits are retained; installer worker made no production edits. Prior native-installer research downloaded official scripts into `/tmp/agentpier-official-*-install.sh`; do not execute against the real MacBook home. Claude official native launcher is `~/.local/bin/claude`; OpenCode is `~/.opencode/bin/opencode`; Codex native script supports `CODEX_INSTALL_DIR` and stores standalone payload under `CODEX_HOME/packages/standalone`.

## Review and validation

Version 1.2.0 implements the complete UI/backend scope above. The full non-browser check passed 701 tests; an additional preference-concurrency regression subsequently passed with the preference suite. Lint, formatting and the 600-line structure limit passed. All 173 browser tests passed after updating legacy provider fixtures for native auth polling and Auto defaults.

The final review corrected shell deep-link normalization for the new Files tab, root-directory containment, stale preview responses, and concurrent preference updates. Native installation tests use disposable homes. One existing cleanup fixture initially invoked the real Claude native installer in its temporary home successfully; it was corrected to explicitly test npm so normal tests remain deterministic and offline. No development-user global installation was performed.

## Deployment

Version 1.2.0 activated successfully on the Mac mini without rollback (job `70acba8e-5a08-4267-87dc-45f9508ac94d`). Health returned no warnings. The existing Claude session remained running. The accounts, repositories, MCP settings and session Files deep links returned HTML over the existing Tailscale HTTPS address. Three managed Claude accounts reported authenticated; the local host account reported unauthenticated. Only status metadata was read. An owned temporary Shell session wrote a fixture file and exercised folder creation, project listing and preview through the deployed API; the session and directory were then removed. The development instance also runs 1.2.0 on port 4380.

The deployed native installer smoke additionally installed Codex 0.153.4, Claude Code 2.1.263 and OpenCode 1.18.29 into separate temporary homes on the Mini. All three native executable checks succeeded and the temporary homes were removed. Existing managed npm installations were not migrated or replaced.
