# Native request bridge capability contract

Research and isolated verification: 2026-09-07. No global installs, model inference, or inspection/control of existing user sessions was performed.

## Architecture and compatibility

Chat requests belong to live native channels, not transcript parsing or terminal text fingerprints. The existing real Terminal remains attached to its original tmux session. Only newly launched interactive work sessions receive `nativeRequests: {enabled:true,version:1}`. Existing sessions, login, shell and headless pipeline launches retain their previous behavior.

| CLI                 | Implementation                                                                                                        | Evidence                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Codex 0.153.4       | Dedicated native `codex app-server --stdio`, transparent private WebSocket proxy, and the actual `codex --remote` TUI | Installed `--help`, installed generated TypeScript protocol, actual isolated TUI/app-server smoke with injected native requests |
| Claude Code 2.1.263 | Per-launch plugin containing command hooks for `PermissionRequest` and `PreToolUse` matching `AskUserQuestion`        | Installed version/help, official hook contract, actual helper subprocess and public HTTP tests                                  |
| OpenCode 1.18.29    | Per-launch TUI plugin using its existing live `api.client` and `api.state.session`                                    | Versioned 1.18.9 SDK, upstream TUI specification, actual isolated 1.18.29 server/TUI/plugin smoke with injected native events   |

OpenCode was initially absent. After explicit authorization for isolated CLI installation testing, the existing ToolInstaller installed 1.18.29 into an owned temporary data directory and temporary home. Its actual TUI and native server passed the protocol smoke. The temporary installation was removed afterward. Unsupported plugin APIs keep native Terminal handling; normal request integration does not install or switch versions automatically. `nativeRequests.enabled` records launch integration, not a live inference or CLI-version certification.

## Codex

The installed CLI accepts `--remote ws://host:port` and `--remote-auth-token-env NAME`. It rejects WebSocket URLs containing a path. AgentPier therefore uses an ephemeral loopback port and a random bearer token in the TUI child's environment. Tokens do not appear in argv or public session metadata. Only one authenticated TUI connects to the proxy.

The app-server runs inside an IPC-linked detached process group with a live keeper. Normal TUI exit, termination and abrupt wrapper death clean up the exact owned backend group, including TERM-ignoring descendants; unrelated processes remain untouched.

The proxy preserves unrecognized native traffic. It mirrors recognized pending requests to the local broker while forwarding the original request to the real TUI. Either a native TUI answer or Chat answer synchronously claims the native request before a single upstream write. Native `serverRequest/resolved` notifications expire the corresponding Chat occurrence. Request IDs retain their original JSON string/number type.

`item/tool/requestUserInput` preserves the complete ordered question array and answers every native question ID with `{answers: {nativeId: {answers: [value]}}}`. Command/file approvals use their `decision` response. `item/permissions/requestApproval` uses the distinct `{permissions,scope}` response; its permission grant lasts the native turn and is labeled accordingly. Deny grants an empty permission object. Only native-offered ordinary command decisions are mirrored. Policy-amendment objects and specialized MCP elicitation forms remain in the native TUI rather than being flattened into misleading generic choices.

Source: [official app-server documentation](https://developers.openai.com/codex/app-server), plus `codex app-server generate-ts --experimental --out <temporary-directory>` from installed 0.153.4. The generated files used were `ServerRequest.ts`, `ServerNotification.ts`, `v2/ToolRequestUserInput{Params,Question,Response}.ts`, `v2/{CommandExecution,FileChange,Permissions}RequestApproval{Params,Response}.ts`, and `v2/ServerRequestResolvedNotification.ts`.

## Claude Code

Permission hooks return the documented `hookSpecificOutput` decision with behavior `allow` or `deny`. Question hooks return `PreToolUse` with `permissionDecision:allow` and `updatedInput` containing the original questions and answers mapped by question text. A live hook invocation supplies the response channel; AgentPier does not invent a Claude native permission request ID. Empty output hands the operation to the native Terminal flow. Hook input timeout and unavailable/disconnected web service release that flow without synthesizing consent. Hooks run before the ordinary native prompt, so Chat includes explicit Terminal handoff rather than claiming both original dialogs are active simultaneously. [Claude hooks reference](https://code.claude.com/docs/en/hooks#permissionrequest)

## OpenCode

The loader requires `default export {id,tui}`; named exports alone are ignored. A regression test and actual native loading verify this boundary. The 1.18 TUI plugin API exposes `api.route.current`, `api.state.session.permission(sessionID)`, `api.state.session.question(sessionID)`, `api.client`, and lifecycle disposal. AgentPier only mirrors requests owned by the currently visible native session and rechecks that native state before delivery. [TUI plugin API specification](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/specs/tui-plugins.md)

Permissions call `api.client.permission.reply({requestID,reply})`; questions call `api.client.question.reply({requestID,answers:string[][]})`. Questions do not become a new chat message. Native missing/resolved requests remain non-repeatable. [Versioned 1.18.9 SDK](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.9/packages/sdk/js/src/v2/gen/sdk.gen.ts)

The native `always` decision applies to suggested patterns for the current OpenCode session. The UI labels it as session-scoped and includes those future patterns in request details. [OpenCode permission semantics](https://opencode.ai/docs/permissions/#what-ask-does)

## Shared delivery and privacy contract

- Browser occurrence IDs are HMAC-derived from a per-launch secret, helper epoch and local occurrence key. They are separate from native request IDs and retain identity across a web restart only when the still-running helper confirms the request remains pending.
- The broker requires session/account/tool ownership, live connection and exact expected revision. It validates permission choices and complete question coverage before claiming an answer. Failed or uncertain delivery cannot be retried automatically; native Terminal remains available.
- The native helper also claims before awaiting I/O. Browser double-clicks, two browser clients, delayed requests, resolved native prompts and repeated identical content cannot trigger a second answer.
- Question option values are native labels. This avoids interpreting arbitrary free text such as `o0` as an invented choice identifier. All questions, multi-select flags, descriptions and secret flags remain available to the UI.
- Only occurrence metadata and a small decision enum enter audit/notification events. Native request IDs, launch tokens, commands, prompts and answers are excluded. A bounded private created-event ledger prevents duplicate initial events across helper reconnection and web restart.
- `requests/` is runtime state and must be excluded from restore. Historical snapshots cannot recreate actionable requests. Active release helpers reference their original immutable release paths and must not be pruned while sessions remain live.

## Reproducible verification

`node scripts/smoke-native-requests.mjs /absolute/path/to/codex` launches a temporary home, an inert localhost provider, the actual Codex app-server and actual TUI. It injects synthetic native request frames into the owned transport, checks Chat question delivery, presses Enter in the owned native question UI, rejects a stale Chat answer, and sends a native permission denial. It explicitly blocks any `turn/start`; no inference request is made. The first native run caught the unsupported URL-path form and the corrected bearer transport passed.

`node scripts/smoke-opencode-requests.mjs /absolute/path/to/opencode` uses the real native server, real TUI, and unmodified request plugin. A loopback HTTP/SSE proxy injects synthetic native question/permission events and captures their exact SDK replies. It checks Chat question delivery, permission denial, a real Terminal Enter answer, stale Chat rejection and exactly one reply. Model-turn endpoints are explicitly blocked and all provider credentials/configuration are isolated; no inference occurs. The first contract check caught the required default-export module shape.

Focused unit/integration/blackbox/property/matrix tests cover the real Unix and WebSocket transports, actual Claude helper subprocesses, native OpenCode client calls, complete forms, free-text collisions, exactly-once delivery, native races, disconnection, web restart deduplication, owner authentication, symlinked storage, a competing broker, unknown delivery, and per-launch profile/mode isolation.

## Codex startup hook trust (2026-09-12)

Codex 0.153.4 performs startup hook review locally in its TUI, rather than issuing
an app-server approval request. The owned proxy now observes the TUI's initial
`hooks/list` exchange before thread start/resume and publishes untrusted/modified
hook metadata to the existing request panel in both Chat and Terminal. Buttons and
explanations are localized in German and English; native hook definitions remain
verbatim review evidence. Nothing is trusted automatically.

A Chat decision controls only the recognized native startup menu under the session
lock. It verifies account, private launch identity, hook count and selection before
sending one Enter. Trust succeeds only after observing the native `config/batchWrite`
response for the exact displayed hook hashes, using Codex's own persistent trust
storage. Terminal decisions, thread startup and channel closure retire stale requests.
Unexpected menus, changed launches or unsupported layouts never receive blind Enter.
The currently supported menu includes the clipped warning at 50 columns; arbitrary
custom keymaps and future native layouts are not assumed compatible.

Fresh Chat input is also refused at the native startup menu before request polling
catches up. Rejected delivery journals remain `reserved`. An explicit retry may use
the current session for a proven never-pasted message even before the first native
binding receipt exists; pasted or ambiguous attempts retain strict recovery identity
and composer checks. The original draft does not need to be dismissed or retyped.

Reproduce using only disposable profiles, private tmux and the loopback mock provider:

```sh
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --bound --hook-trust --http --samples 1
```

The probe starts without hook-trust bypass, approves at 50 columns through the real
HTTP endpoint, verifies native persistent trust, rejects input before paste and
successfully retries the original message. It also runs the existing busy queue,
multiline, long-payload and recovery checks. No real user credentials or sessions
are used. This requires no new runtime dependency or installer exception.
