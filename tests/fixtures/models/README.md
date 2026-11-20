# Native model picker captures

Only layouts of the supported CLI releases are kept (from each CLI's `minVersion`,
see `docs/cli-updates.md`); captures of older layouts are removed with their parsing.

`claude-2.1.329-model.ansi` (120 × 50) and `claude-2.1.329-model-50.txt` (50 × 40)
were captured from Claude Code 2.1.329 on macOS with private tmux sessions, a
disposable home, a synthetic API key and a loopback API address, which shows no
"More models" row. Opening, selecting and cancelling the picker required no model
requests. The captures retain native line wrapping. The workspace path in the header was replaced with `/fixture`.

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
