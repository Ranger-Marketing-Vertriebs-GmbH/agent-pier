# Native model picker captures

`claude-model-50.txt` and `claude-model-80.txt` were captured from Claude Code
2.1.270 on macOS with private tmux sessions at the corresponding column widths.
The captures retain native line wrapping. ANSI styling, trailing padding, the
startup header and temporary workspace paths were removed; menu text was preserved.

The probe used a disposable home, a synthetic API key and a loopback API address.
Opening, selecting and cancelling the picker required no model requests. The
wrapped session-only footer and option descriptions are regression fixtures for
the chat model controller.

`claude-2.1.329-model.ansi` (120 × 50) and `claude-2.1.329-model-50.txt` (50 × 40)
were captured the same way from Claude Code 2.1.329 with an API key, which shows no
"More models" row. The workspace path in the header was replaced with `/fixture`.

`claude-2.1.329-more-collapsed.txt`, `-more-focused.txt` and `-more-expanded.txt` are
reconstructed, not captured: the expander only appears with a subscription's model
catalog. The collapsed screen follows an owner screenshot of 2.1.329; the focused and
expanded screens follow Claude Code's renderer (the row's `▸`/`▾` marker in place of a
number, models below it numbered on, the effort row hidden and an "Enter to expand"
or "Enter to collapse" footer while the row has the focus). The older models listed
under the row are placeholders.

`codex-0169-composer.ansi` (120 × 40) and `codex-0169-composer-wrapped.ansi` (80 × 40,
a deep working directory) are idle Codex 0.169.1 screens from a disposable
`CODEX_HOME` with a synthetic API key and an unreachable API address. Temporary path
segments were replaced with placeholders of the same length, so the footer wraps as
captured.
