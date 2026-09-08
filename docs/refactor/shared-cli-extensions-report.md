# Shared CLI extensions and Agency Agents — release 1.3.0

## Result

Accounts share the native extension configuration of their CLI by default. The management UI groups accounts by CLI; old account-specific extension/plugin links normalize to the shared profile. Credential stores, main-model/provider settings and native histories remain account-specific. Existing sessions keep running; new sessions apply shared configuration and directory links.

The Agency Agents catalog uses `msitarzewski/agency-agents`, with commit-pinned previews, search, categories, pagination and explicit individual installation. Native Claude/OpenCode Markdown and Codex TOML inherit session model/permissions. No upstream scripts are executed. Modified agent files are retained on removal.

## Review findings addressed

- Conflicting MCP definitions retain a complete canonical entry instead of mixing credentials/arguments from two entries.
- Conflicting skill packages remain whole and never acquire removable ownership of a pre-existing native skill.
- Plugin metadata paths are rebased into the shared store and written atomically.
- Native edits synchronize with per-entry hash baselines; stale profiles cannot resurrect deleted entries. Separate provider directories retain separate baselines.
- Provider connection profiles participate in sharing. Verified shared symlinks are omitted from encrypted logical backups; unexpected links still fail validation.
- Session limit checks precede migration. Plugin mutations serialize aliases of the same CLI.
- Agency install/remove checks pin the revision, bound downloads, preserve attribution and verify file ownership/content. Closing the service aborts pending downloads.

## Verification

- `npm run check`: lint, format, production build, structure and all **721** Node tests passed.
- `npm run test:e2e`: all **175** browser tests passed.
- The two Agency browser tests also passed after adding desktop/mobile screenshots; the mobile preview was inspected visually.
- Generated synchronization properties run 200 cases each for unchanged snapshots and independent account edits, plus a targeted concurrent-conflict regression.
- Native smoke in disposable homes: Codex read its generated MCP configuration, Claude read its generated MCP entry, and OpenCode discovered the generated Agency agent as a subagent. No model calls or global installations were performed.
- Public GitHub catalog smoke: revision `647c8baa42b6842afb4a97bf2c0950d45ba88e8b`, 287 candidates in 19 categories. The deployed server found and previewed Frontend Developer. No catalog agent was installed into the user's profile automatically.
- Every checked source/test file remains at or below 600 lines. Vite still reports a non-fatal initial JavaScript chunk-size advisory; Agency itself is a separate lazy chunk.

## Deployment

The macOS ARM64 artifact passed unpack/runtime smoke checks. SHA-256: `46a9616b0f3626d129946862d4120bcb4815107f5aa76e62bb42a09e4f28e673`.

The Mac mini upgraded from 1.2.0 to 1.3.0 through the existing release activation workflow; the job succeeded without rollback. Native profiles/configuration were backed up privately under `operations/pre-sharing-1.3.0` before migration. Shared imports for all three CLIs completed with no conflicts. All three previously authenticated Claude accounts remained authenticated and the existing user session remained running. HTTPS deep links for accounts, extensions, plugins, MCP settings and the existing chat returned the application document. Both the Mini and local development instance report 1.3.0 with no health warnings.

Logical backups still exclude native shared extensions and Agency ownership records. The filesystem backup requirements and synchronization boundaries are documented in `docs/shared-cli-extensions.md`.
