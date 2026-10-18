# Claude background activity validation

On September 14, 2026, Claude Code 2.1.270 was exercised on macOS arm64 in a
disposable AgentPier application, project, HOME, Claude profile, and private tmux
server. A loopback Anthropic-compatible provider supplied synthetic responses and
a synthetic API key. Seatbelt denied access to the real Claude profile and macOS
keychain; telemetry was disabled. No user session was used for these experiments.

The provider requested a real `Agent` call with `run_in_background: true`, then
ended the parent response while holding the subagent's response for 30 seconds.
Claude displayed a styled `◯ general-purpose` row with elapsed time below the
composer and a `↓ to manage` hint. There was no `esc to interrupt` hint. The row
disappeared after the subagent completed.

A separate run requested a real `Bash` call executing `sleep 25` with
`run_in_background: true`, then ended the parent response. Claude displayed a
static `1 shell` counter in its native footer until the command completed. This
counter does not animate, so its unchanged value must not expire as frozen spinner
evidence. The counter disappeared after completion.

The four wide sanitized `tests/fixtures/tui-input/claude-background-*-native.json`
captures cover both active and completed states. Unit tests use them to check
activity lifetimes and frozen agent timers. The English browser test feeds the
parser results into the session list and chat, checking working indicators and
the return to ready after completion. Earlier busy/queued captures from Claude
2.1.266 also remain covered, including spinner animation that changes only color.

On October 18, 2026, a busy Claude Code session in a 50-column pane showed
"activity unknown". tmux keeps the last viewer's size (`window-size latest`), so
a narrow phone view leaves the pane narrow. At that width Claude clips the footer
and drops `↓ to manage`. It also replaces each agent row's description with a
token counter, for example `◯ Explore   4m 29s · ↓ 67.2k tokens`. The parser
therefore also recognizes the task panel by its `⏺ main` header and accepts that
narrow row layout. It reads the shell counter without the hint and measures the
composer's distance from the start of the panel. Listed agent rows the parser
cannot read report unknown, never ready. The three
`claude-background-*-narrow-native.json` fixtures are redacted reconstructions
of that capture.

These observations cover the installed version's default terminal presentation.
They do not establish compatibility with future or customized CLI layouts. Raw
terminal evidence remains internal to the activity observer and is not returned
in session API responses.
