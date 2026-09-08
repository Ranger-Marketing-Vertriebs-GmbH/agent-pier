# Native operations and remote interaction design

The user authorized autonomous implementation of all six recommendations after the completed pipeline phase. The reference is the user-owned `agent-runner-ce-main.zip`; its implementations are evidence, not code to transplant. Baseline: `f968cd5`, 464 backend tests and 130 browser tests per engine. The baseline check was repeated successfully for this phase.

## Scope and constraints

- Implement PWA/Web Push, native Chat permissions/questions, diagnosis, backup/restore, versioned updates/rollback, and a persistent audit view.
- Preserve the actual Codex, Claude Code and OpenCode TUI, existing Chat, dark/orange style, mobile layout and URL-owned navigation.
- Keep English first-party code/comments; German copy belongs in locale modules. Source, style and test files remain at most 600 lines.
- Support Node 22.13+, macOS/Linux and the platform's existing CLI installations. Never install a global CLI/service or perform paid model inference on this MacBook.
- Tests own temporary data, homes, repositories, sockets and subprocesses. Never input to, stop, migrate or delete the protected real sessions from the previous phase.
- Credentials, native request capabilities and push subscription secrets never enter audit records or ordinary API metadata.
- Use the existing feature checkout and runtime paths, retaining the established in-place development preference. Independent workers have explicit file ownership; root integrates shared composition. The user already approved these features and autonomous implementation, so routine design choices require no additional approval round.

## Architecture

Keep each subsystem separate under `server/features/{audit,notifications,requests,operations}` and matching frontend feature folders. Reuse existing account/provider configuration, session launch orchestration, same-origin authorization, modal/select controls and private storage helpers. Add narrow composition in `server/application`, feature routers in `server/http/routes`, and an operational CLI entrypoint under `scripts`.

Settings owns URL-addressable sections: `/settings`, `/settings/notifications`, `/settings/diagnostics`, `/settings/backups`, `/settings/updates`, `/settings/audit`. Native requests render inside Chat. Avoid another long top-level navigation group. The existing `/settings` working-directory form retains its behavior.

## Audit and notification events

`AuditStore({dataDir})` stores bounded typed events in `audit/audit.sqlite` using SQLite WAL. `append({action,resourceType,resourceId?,sessionId?,projectId?,outcome,source,details?})` accepts known action/metadata schemas, never arbitrary request bodies or native output. `list({page,action?,outcome?,sessionId?,projectId?})` returns `{events,total,page,pageSize:25}` with stable ordering; `export()` supplies backup records. Invalid filters fail rather than become SQL fragments. Public records identify what happened and when, without pretending to be tamper-proof against the same OS user.

Record successful/failed user mutations at the HTTP boundary with explicit action mappings; also record native session completion, request resolution and automatic pipeline/operation transitions at their authoritative service boundaries. A small event sink lets push consume lifecycle/request transitions independently of audit persistence. A failed push never fails the originating operation.

`NotificationService({dataDir,send?,clock?})` persists subscriptions and delivery identities privately. `status`, `subscribe`, `unsubscribe`, `test` and `observe` are separate methods. VAPID private material stays private. Use the maintained `web-push` implementation instead of copying reference cryptography. Validate HTTPS endpoints and prevent local/private network targets, use bounded send timeouts, remove expired subscriptions, and deduplicate durable event occurrences across polling and web restarts. Subscriptions belong to the authorized owner and an opaque browser installation ID.

Push is an explicit device opt-in. Notify only for permission/question requests, session completion, and pipeline human gates/completion. Payloads contain IDs, event kinds and generic copy, never prompts, commands, answers, repository paths or credentials. Notification clicks open existing deep links and never perform an approval. Detection continues while the browser is closed; no hidden PTY is attached or resized.

The PWA includes a manifest, appropriate icons, install guidance and a service worker. Cache only an explicit public static shell/offline document; never cache APIs, session pages containing data, histories or private artifacts. Do not globally delete unrelated caches, silently reload the active chat, or claim the offline shell can operate a disconnected CLI. Failed subscription persistence must be visible and retryable; browser/server unsubscribe divergence must be recoverable.

## Native requests

`RequestBroker` owns live native request occurrences. Browser IDs are opaque and separate from native RPC/request IDs. A request contains `{id,sessionId,kind,revision,status,questions?,options?,subject?,source,createdAt}`; native connection, process epoch and destinations remain internal. `list(sessionId)` exposes current requests. `answer(sessionId,id,{expectedRevision,choice?,answers?})` validates full question coverage and permitted choices under a lock, claims the occurrence before delivery, and never redelivers on duplicates or an uncertain outcome. `handoff` releases a native hook to Terminal; `discard` invalidates a session's channels. Historical snapshots cannot resurrect actionable requests.

Claude supports per-launch `PermissionRequest` and `PreToolUse:AskUserQuestion` hooks, preserving native TUI and existing plugins. A live hook invocation supplies the occurrence identity and return channel; no invented native request ID. Empty hook output hands control back to normal native handling. OpenCode uses the existing in-TUI plugin's connected native client and pending request store; questions must call the question reply API rather than submit a new chat message.

Codex permission hooks are available, but there is no documented question-answer hook. Implement and verify a new-launch native app-server bridge with the real Codex TUI attached through its supported remote transport, or an equally strong native channel. Do not declare complete by omitting Codex questions, changing Terminal into a JSON log, or treating a screen-text hash as native occurrence identity. Existing sessions are not silently migrated. Record the final version/capability contract in the implementation report.

Chat shows all questions, descriptions, free text and multi-selection using request-keyed forms. Disable concurrent submissions, display stale/unknown-delivery states accurately, and retain a Terminal path. Native Terminal responses win races and remove the corresponding Chat action. Shell, login and engine-owned headless pipeline sessions do not acquire inappropriate interactive controls.

## Diagnostics

`Doctor.run({scope:'host'|'project',projectId?,deep:false})` returns `{version,generatedAt,checks:[{id,status,summary,remedy?,details?}]}` with status `ok|warn|fail|skip`. Share the service between UI and CLI. Inspect read-only metadata instead of constructing application services that mutate state. Bound version commands and probes. Cover Node/platform, PTY/tmux/Git/CLI resolution, service/listener, storage ownership, disk space, database integrity, missing projects and account/provider prerequisites. Network credential probes are explicit and never model calls. Unknown or untested conditions remain distinguishable from success.

## Backup and restore

Use a versioned logical archive with a manifest, checksums, component/capture metadata and explicit omissions. Snapshot WAL databases with SQLite facilities. Capture related application settings under a short mutation barrier; independent native writers require recorded per-component boundaries, not a false globally atomic snapshot claim. Compression/encryption occur after releasing the barrier. Live native sessions continue.

`Backup.plan/create({includeHistory:true,withCredentials:false,passphrase?})` returns an owned artifact ID and manifest. HTTP writes only under the owned backup directory and exposes list/download/delete controls. Native managed configuration and credentials require an encrypted capsule; external local CLI profiles/keychains, platform binaries and repository worktrees are excluded and reported. Default history may contain private task content; do not label it universally secret-free.

`Restore.inspect({archive,projectMap})` validates before mutation. `Restore.apply({archive,targetDataDir,projectMap,passphrase?})` creates a fresh target by staging then atomic rename; it never overwrites the running data directory. Bound archive size/expansion and reject traversal, links, duplicate members, invalid manifests, checksum failures, unsupported schema and corrupt SQLite. Authenticate credential metadata with a fixed bounded scrypt/AES-GCM envelope; passphrases are never argv or logs.

Project remapping recomputes Git path/device/inode identity, preserves all memory revisions and maps verification configuration. Import sessions/runs as historical, clear all live capabilities/recovery intents and never grant imported worktree receipts cleanup/push rights. Preserve AgentBus messages as history without re-delivering pending messages. Regenerate provider paths for new sessions and report native reauthentication/tool reinstall requirements. UI guides archive inspection and fresh-target restore; CLI supports encrypted credentials and offline restore.

## Versioned updates and rollback

Use `installRoot/releases/<version>`, a stable `current` pointer and stable launcher with `dataDir` outside release directories. `Releases.check/stage/activate/rollback` separate planning, staging and switching. Use explicit platform artifacts for darwin/linux arm64/x64, bounded downloads, validated manifests, archive containment, checksums and layout/native-dependency smoke checks. Define publisher verification explicitly; integrity alone must not be described as authenticity.

An external helper restarts only the web service, verifies expected version/health, and returns to the previous pointer on failed activation. Keep immutable releases used by active native helpers, MCP servers and verification workers; do not copy the reference's blind newest-two pruning. Reject schema-incompatible rollback and never restore old databases over newer user writes. Source checkouts show an honest setup requirement; implement and test a real release packaging/staging/activation path rather than only disabling buttons. No global service is installed here.

## Verification and completion

Each feature needs focused failing-then-passing behavior tests, public HTTP/CLI tests and mobile/desktop browser coverage. Generate archive, URL, filter, crypto-tamper and request-shape cases with reproducible property seeds. Matrix native tool/profile/mode combinations and platform/service states. Exercise a real isolated native session surviving backup/update, fresh restore opening successfully, and exactly-once native answers under races/restarts. Web Push tests verify actual encrypted payload exchange against controlled fixtures; physical device delivery remains an explicit external prerequisite.

Completion requires every feature and UI/CLI workflow above, independent review, full `npm run check`, alternate property seed, Chromium/WebKit suites, all six remote CI jobs, documentation, clean committed/pushed state and an owned local runtime smoke check with protected processes preserved.
