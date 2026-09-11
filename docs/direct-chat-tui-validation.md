# Direct chat TUI validation

Native characterization was run on 2026-09-11 using macOS arm64 (Darwin 25.5.0),
Node.js 26.7.0, and private tmux sessions at 120 × 35 cells. Each run created a
fresh application data directory, HOME, provider profiles, and project. No existing
user session, credential file, or default tmux server was used. Initial Claude
characterization used `--bare`, which its installed help documents as disabling
keychain/OAuth reads. The final bound Claude run enabled the real plugin hooks in
normal mode, with both profile directories redirected to the fixture. On macOS,
Seatbelt denied reads of the actual user keychain/Claude profiles and execution of
`/usr/bin/security`. An unprivileged, ad-hoc-signed copy of the system `ps` binary
inside the fixture allowed real process inspection under Seatbelt; the platform
`/bin/ps` refuses execution inside that sandbox. This copy was removed with the
fixture and did not replace the system binary.

The local provider implements minimal Responses and Anthropic streaming responses
on a dynamically allocated loopback port. Its credential is the literal synthetic
string `synthetic-probe-key`; it never requests tool execution. This exercises the
real installed CLIs and their input queues, while synthetic recorder tests exercise
only byte transport. Neither establishes provider billing, authentication, or
behavior during actual tool execution.

## Reproduce

```sh
node scripts/probe-chat-tui.mjs --synthetic
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock
node scripts/probe-chat-tui.mjs --native --tool claude --local-mock
node scripts/probe-chat-tui.mjs --native --tool opencode --local-mock
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --http --bound
node scripts/probe-chat-tui.mjs --native --tool claude --local-mock --http --bound
node scripts/probe-chat-tui.mjs --native --tool opencode --local-mock --http --bound
```

Native mode without explicit `--local-mock` exits with status 2 and a
`not-executable` result. The probe never imports real credentials. The fixture owns
and removes its processes, private tmux socket, profiles, and project. Only
synthetic markers, timing summaries, and sanitized screens are printed.

Add `--http` to test the current application HTTP delivery path, including durable
receipts and composer guards. This records server HTTP-entry-to-Enter-completion
separately from caller-start-to-receipt and visible-echo latency. Native runs use
one stable delivery ID per HTTP operation, without automatically retrying failed
operations. Without `--http`, measurements describe direct tmux input only.

## Native input characterization

| CLI         | Installed version | Held-response observation                                                                                        | Submit                                                 |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Codex       | 0.153.4           | Second marker shown under “Messages to be submitted after next tool call” while the first response remained open | Separate Enter after bracketed paste, zero added delay |
| Claude Code | 2.1.266           | Second marker shown in the native queue; empty composer displays “Press up to edit queued messages”              | Separate Enter after bracketed paste, zero added delay |
| OpenCode    | 1.18.30           | Second marker shown in a message card marked QUEUED while the first response remained open                       | Separate Enter after bracketed paste, zero added delay |

The provider held the first response open for eight seconds. The probe submitted a
second marker after observing the first provider request and a 1.5-second pause.
It asserted that the native queue indication appeared before the held response
completed. It then observed a synthetic response to the second marker. This is an
observed native queue acceptance, independently of the terminal write result.

Each CLI additionally completed 30 sequential short-marker prompts. Every prompt
received one bracketed paste and one subsequent Enter; the probe never sent a
second Enter to compensate for a timeout. Existing Codex literal slash commands
retain their separate 250 ms paste-burst interval; these measurements do not test
removing that interval.

Fresh Codex and Claude onboarding required a 750 ms pause after displaying a
trust/key confirmation before sending the one authorized onboarding selection. Earlier
attempts sent startup keys before the dialog input handler was ready; those runs
stopped without sending a prompt. This startup accommodation is separate from the
zero-delay paste/Enter message transport.

## Local direct-tmux measurements

Values are milliseconds, rounded to two decimal places; 30 samples per CLI. The
start clock is the probe process immediately before tmux buffer loading. Submit
includes buffer loading, paste, Enter, and buffer cleanup. Visible echo is polled
via capture-pane at approximately 20 ms intervals and is an upper-bound observation,
not the moment of a terminal render or provider acceptance.

| CLI         | Submit p50 | Submit p95 | Submit max | Visible echo p95 |
| ----------- | ---------: | ---------: | ---------: | ---------------: |
| Codex       |      17.63 |      22.91 |      23.37 |            28.32 |
| Claude Code |      19.56 |      21.75 |      21.97 |            27.21 |
| OpenCode    |      19.28 |      21.77 |      22.86 |            28.01 |

The synthetic recorder separately observed exactly one bracketed payload followed
by one carriage return for each of 30 markers per tool. Its p95 direct-write
latencies were 22.25 ms (Codex label), 24.90 ms (Claude label), and 22.72 ms
(OpenCode label). The recorder labels do not change the executable: all three are
a synthetic raw-TTY Node.js program. These values are not native CLI benchmarks.

The old Codex queue path was not benchmarked before production edits. These
measurements therefore do not establish an improvement over the old queue path or
explain an earlier report of multi-second latency.

## HTTP delivery and native recovery

The final complete HTTP route, including actual `NativeSessionBinding.prepare`
launch hooks/plugins, live native receipts, composer guards, and durable journal
writes, passed the held-response/second-queued scenario and 30 sequential prompts
per CLI. No request, model, identity, or receipt guard was stubbed. Final runs
completed at 16:00–16:02 UTC on 2026-09-11. Instrumentation measured
HTTP server entry and completion of the actual tmux Enter command with the same
monotonic clock. These runs were concurrent with other development validation. Their measured
HTTP-entry-to-Enter p95 values meet the local 500 ms objective; no unloaded-host
claim is made. The earlier direct-tmux table remains a separate transport measurement.

| CLI         | HTTP entry → Enter p50 | HTTP entry → Enter p95 | Maximum | Visible echo p95 |
| ----------- | ---------------------: | ---------------------: | ------: | ---------------: |
| Codex       |                 138.55 |                 151.81 |  152.56 |           892.26 |
| Claude Code |                 148.39 |                 207.93 |  250.65 |           684.14 |
| OpenCode    |                 147.57 |                 198.00 |  232.31 |           909.02 |

Claude and OpenCode had verified native receipts before the first HTTP message.
Codex creates its native receipt only after its first UserPromptSubmit in this
configuration. Its final run therefore sent the first message through HTTP with a
validated pending launch, then required the real hook receipt before proceeding.
No direct bootstrap message was used in any final bound run. A pending native
identity authorizes initial delivery but records no recovery identity; it cannot
be used to recover a potentially submitted prompt. Missing/invalid launch records
and invalid existing receipts still reject input.

The echo interval begins at the caller before HTTP and is observed after receipt;
it is intentionally separate from HTTP-entry-to-submit. Earlier heavily concurrent
runs had roundtrip p95 values above 500 ms; the local objective applies to an
unloaded host, so those values are not silently dropped or used as acceptance.

For each actual CLI, the HTTP probe also persisted `pasted` and then injected one
storage exception, leaving the full short marker visible in the native composer.
Recovery returned `submitted-existing`: **zero new pastes and one Enter**. Replaying
the recovery attempt produced zero additional writes. A second injected failure
left a different draft; deleting its last three characters manually caused recovery
to return `blocked` with zero writes and unchanged composer contents.

These recovery assertions count real tmux paste and Enter commands independently
and verify the recovered marker receives a native response. The fault injection
runs only in the disposable application. It does not claim to reproduce an OS
crash, nor permit retry after `submit-intent`.

## Native multiline and long payload acceptance

A separate bound HTTP run with `--samples 1` exercised two additional payloads per
CLI, while retaining the 30-sample timing table above. The first combines CRLF/CR
normalization, Unicode (`Grüße`, CJK, emoji), a path with spaces, a tab, and multiple
lines. The second contains 120 lines and 9,013 UTF-8 bytes after normalization,
well beyond the pane's visible height. Each case produced exactly one tmux paste,
one Enter, and a visible native response to its unique marker.

The local provider compares SHA-256 and byte length of actual user text blocks in
completion requests. Token-count requests are excluded. It retains only synthetic
marker/length/hash evidence, not payload text. Provider preservation is distinct
from AgentPier's exact byte transport: the installed CLIs apply these observed
native transformations.

| CLI         | Multiline payload at provider                                         | Long payload at provider                               |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Codex       | Exact normalized input, 93 bytes                                      | Exact normalized input, 9,013 bytes                    |
| Claude Code | The single tab becomes four spaces; otherwise exact, 96 bytes         | Exact normalized input, 9,013 bytes                    |
| OpenCode    | One ASCII space appended; otherwise exact including the tab, 94 bytes | One ASCII space appended; otherwise exact, 9,014 bytes |

The probe asserts those precise transformations; it does not call them unchanged
provider text. The normalized multiline SHA-256 is
`a186aed178a9f7c5ba20f196d0a537d2d778c414a508085d1c82da8019fd5c9b`,
and the normalized long-payload SHA-256 is
`f4044dee18f1c3a5ae1cf8811dbc046054d8e968f88d0db7928478a1770f3619`.
No text or line loss beyond the stated native whitespace transformations was
observed. No compensating Enter, retry, or production adapter change was used.
The same runs also retained the busy-input and short-draft recovery assertions.

```sh
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --http --bound --samples 1
node scripts/probe-chat-tui.mjs --native --tool claude --local-mock --http --bound --samples 1
node scripts/probe-chat-tui.mjs --native --tool opencode --local-mock --http --bound --samples 1
```

## Composer evidence and release boundaries

### Terminal Shift+Enter

The attached terminal path has a separate native keyboard probe:

```sh
node scripts/probe-chat-tui.mjs --native --tool codex --local-mock --bound --keyboard-only
node scripts/probe-chat-tui.mjs --native --tool claude --local-mock --bound --keyboard-only
node scripts/probe-chat-tui.mjs --native --tool opencode --local-mock --bound --keyboard-only
```

On the macOS host and CLI versions above, tmux 3.7c reduced the previous CSI-u
Shift+Enter sequence to plain Enter. The corrected mapping sends native Alt+Enter
(`ESC CR`) through the same attached client used by the browser. Each CLI retained
both lines without a provider request, then accepted the exact 39-byte multiline
text after one ordinary Enter. All three yielded SHA-256
`c4669f280f5da711262b55032517ca15fb18df60bbd1fc054d65c1e345f23ac9`.
The probe also waits for the first typed line before inserting the newline.
Custom CLI keybindings remain outside this characterization.

### OpenCode with AgentBus enabled

On September 11, 2026, the native OpenCode 1.18.30 probe was repeated with
`--native --tool opencode --local-mock --bound --keyboard-only --agentbus` on
macOS arm64. Before the SQLite adapter fix, the real plugin failed with
`No such built-in module: node:sqlite` and no provider request arrived. With
the runtime-specific built-in driver, the same probe preserved Shift+Enter
without submitting, then delivered the exact multiline payload after Enter.
The probe uses an isolated profile and a loopback synthetic provider, without
real credentials or model tool calls. Separate Node/Bun interoperability tests
cover message deduplication, exclusive claims, acknowledgements, and recovery
after a reader exits.

The same AgentBus-enabled keyboard probe also passed for Codex 0.153.4 and
Claude Code 2.1.266 on that host. All three delivered the same 39-byte UTF-8
payload, SHA-256 `c4669f280f5da711262b55032517ca15fb18df60bbd1fc054d65c1e345f23ac9`.

### Composer parsing

Sanitized `tests/fixtures/tui-input/*-native.json` files contain actual styled
`capture-pane -e` output and tmux cursor coordinates. Plain screen text is
insufficient to distinguish a placeholder from a user who typed exactly that
placeholder. The parser uses cursor position, styling, composer boundaries, and
complete visible input; unknown states must reject before writing.

Observed states include idle, busy, queued-while-busy, and a short Unicode draft.
OpenCode also has a native Plan-mode composer capture produced by Tab; its message
benchmark ran in Build mode.
Codex uses a dim placeholder and bold `›`; Claude uses a `❯` composer between
horizontal rules and an inverse-video cursor; OpenCode uses a left `┃` border,
model footer, and bottom border. These are observations of these installed
versions with their default styles and keybindings, not a promise that future
versions or customized themes preserve them.

The broader native recovery matrix remains open: multiline or collapsed drafts,
partially pasted prompts, approval/model dialogs, process replacement, and ambiguous
submit history need separate acceptance. Short complete drafts, explicitly edited
drafts, and recovery replay were exercised through actual HTTP and native TUIs. Replaying a text marker
from scrollback never proves the current composer contains that text. The probe
captures a draft without submitting it, then disposes its own session.

The remaining native matrix must be recorded before claiming full release
acceptance. Linux, custom keybindings/themes, actual tool
execution, and simultaneous external tmux/SSH typing are not covered by this run.
