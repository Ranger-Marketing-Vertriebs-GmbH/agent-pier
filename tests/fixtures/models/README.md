# Native model picker captures

`claude-model-50.txt` and `claude-model-80.txt` were captured from Claude Code
2.1.270 on macOS with private tmux sessions at the corresponding column widths.
The captures retain native line wrapping. ANSI styling, trailing padding, the
startup header and temporary workspace paths were removed; menu text was preserved.

The probe used a disposable home, a synthetic API key and a loopback API address.
Opening, selecting and cancelling the picker required no model requests. The
wrapped session-only footer and option descriptions are regression fixtures for
the chat model controller.
