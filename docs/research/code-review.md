# Final whole-product review

Spec verdict: approved. The implemented product satisfies the core functional and safety design, including the fixes from the initial backend review. Quality verdict: approved. No concrete blocker remains in the reviewed scope.

## Resolved final finding

**P2 — Account deletion wording: resolved in `02cb0f9`.** I inspected the exact change at `web/App.jsx:1277`. The confirmation now promises removal of the profile/local files and, for Claude, explicitly states that CLI-managed Keychain entries may remain. The decision-point wording now matches the safe backend behavior and README.

## Verified fixes and cross-layer assessment

- The local-Host Tailscale owner bypass is fixed. The local branch rejects forwarding/Tailscale markers. My earlier scoped pure reproduction now returns 403. The controller additionally verified actual remote owner access returns 200 and a substituted local Host returns 403.
- Multiline composer input now uses `paste-buffer -p -r`. The new raw-input regression checks exact bracket markers, preserved linefeeds, and Enter only when requested; the controller reports it passed. This directly addresses the previously identified premature-submit defect.
- Session selection is keyed by ID, with independent terminal lifecycle cleanup. Reconnect resets the local emulator and attaches to the existing tmux session. Browser closure disposes only the attachment. Status polling updates ended sessions and disables their mutation controls appropriately.
- The reader displays escaped terminal text, polls only when active, preserves failed submissions, and sends to the same backend session. Native terminal and mobile key controls remain available for permission/menu interaction. No fabricated tool events or automatic permission approval were introduced.
- Managed account creation/edit/login and deletion use the specified endpoints; existing local accounts lack destructive management controls. API keys are entered through password inputs and are not returned to the UI. Missing tools stay visible and cannot launch.
- Stop/removal confirmations distinguish terminating a live process from deleting retained output. Session/account validation and server-side guards remain in force. Private storage, loopback binding, owner checks, isolated tmux ownership and LaunchAgent behavior remain consistent with the design.
- README accurately describes process lifetime, sleep/reboot limits, private data, native permission boundaries, account isolation, OpenCode's OpenAI key interpretation, and limitations of terminal-derived history. The service retry handles the observed launchd teardown race without affecting tmux sessions.

## Review scope and evidence

Read-only inspection of current `web/*`, `server/*`, `scripts/*.mjs`, README and the frontend diff, plus the new raw-input regression. Only this report was written. The controller supplied successful native Codex/Claude startup/reconnect checks, security/API checks, the actual Serve checks, real service reinstall/running verification, a real full-backend/PTY browser flow, and five UI contract tests. I did not rerun tests, mutate accounts/processes, inspect private owner identity, or install OpenCode. Root is independently checking rendered desktop/mobile screenshots and native UI. No additional material privacy, destructive-action, mobile/TUI or completion gap was identified within this scope.

## Final scoped closure

Inspected `02cb0f9`, `d0ae5e5`, and `docs/verification.md` without rerunning tests. The reader's `trimEnd()` change removes trailing empty terminal rows while preserving leading indentation and internal spacing; its browser regression checks those preserved contents explicitly. It changes the reader display only, not the native terminal or transmitted input.

The verification document distinguishes completed checks from operating limits: the Mac must remain awake, OS reboot ends CLI processes, the reader is terminal text rather than semantic chat, personal OAuth completion remains a user action, no model tasks were run against existing projects, and absent OpenCode received only detection/profile coverage. Its stated test totals match the controller's final evidence: 27/27 Node tests and 8/8 browser tests, plus actual Codex/Claude HTTPS/WSS checks without JavaScript page errors. Root has now visually inspected the actual native desktop/mobile screenshots. No remaining concrete blocker was found.

## External-link handoff follow-up

Scoped review of `server/security.js:17–18` and `tests/security.test.js:30–35`: approved. The `openingHome` exception permits only user-activated GET document navigation to the root path (optionally with a query), and explicitly excludes websocket upgrades. It relaxes only the blanket cross-site Fetch Metadata rejection. Socket/Host/proxy restrictions and owner authentication still execute first; an explicit mismatched Origin still fails afterward. API paths, writes and cross-site API fetches do not qualify. This safely permits opening the shared URL or the Remote link without reopening the owner bypass. The new regression covers local and owner-authenticated remote navigation plus denied cross-site fetch. Controller reports 9 scoped security/API tests passed; the complete suite now contains 28 tests and is being rerun by root. No tests were rerun by this reviewer. Final spec and quality verdicts remain approved, with no concrete blocker.

Final controller evidence after navigation fix: `npm test` 28/28 passed; complete `npm run test:e2e` 9/9 passed. The browser link test asserts actual successful navigation; explicit Fetch Metadata variants are separately tested at the authorization boundary and verified via the deployed HTTPS endpoint. Final documentation totals updated accordingly.

## AgentPier follow-up — 2026-09-06

Independent scoped reviews covered repository backend/UI, structured history/tasks and final cross-component integration. All actionable findings were fixed and re-reviewed:

- Clone job state now survives navigation; final project metadata cannot be hidden by a stale list response.
- Application shutdown cancels and awaits owned Git clones, removes temporary credentials/partial destinations, and preserves existing folders.
- Codex paginated history reads newest pages and restores chronological order; empty or partial Claude startup logs wait, while null metadata records cannot crash discovery.
- Codex and OpenCode history processes are awaited during shutdown; new history work is refused once shutdown starts.
- Switching to the native terminal preserves reader drafts, expanded tools and scroll position. Lazy terminal loading sets connection state before enabling terminal keyboard controls.

Final scoped re-reviews reported no further blocking issues. Controller verification: 62 backend/integration tests and 18 browser tests passed, production build passed, desktop/mobile screenshots inspected. This supersedes the earlier installation/verification counts above; there is no permanent MacBook installation in the current state.
