// The AgentPier guard: a Hermes profile plugin (website/docs/user-guide/features/
// plugins.md) whose `pre_tool_call` hook returns `{"action": "approve"}` for every
// shell command, Python run and input to a running process, so each asks the owner
// (website/docs/user-guide/features/hooks.md; tools/approval.py
// `request_tool_approval`). The message carries the command itself: Hermes shows the
// call only as "<terminal> (plugin approval rule)" (Hermes runtime spike). The rule
// key hashes the exact text, so "always" allows that one command again, never every
// command of the tool (an empty key would hash only the message).

export const guardPlugin = "agentpier-guard";
export const guardDirectory = `plugins/${guardPlugin}`;

const manifest = `name: ${guardPlugin}
version: "1"
description: AgentPier asks the owner before every shell command and Python run
`;

const source = `"""AgentPier guard: every shell command, Python run and process input asks the owner.

Written by AgentPier into this agent's Hermes home; AgentPier replaces it on every
configuration change.
"""

import hashlib

# The argument that holds what the tool runs.
_RUNS = {"terminal": "command", "execute_code": "code"}
# process_manage actions that send input to a running process.
_INPUT = {"write", "submit"}
# Longer texts are shortened in the approval card; the rule key covers all of it.
_SHOWN = 4000


def _text(tool_name, args):
    if tool_name in _RUNS:
        return str(args.get(_RUNS[tool_name]) or "")
    if tool_name == "process_manage" and args.get("action") in _INPUT:
        target = args.get("session_id") or ""
        return f"{args.get('action')} {target}: {args.get('data') or ''}"
    return None


def _guard(tool_name="", args=None, **kwargs):
    text = _text(tool_name, args if isinstance(args, dict) else {})
    if text is None:
        return None
    digest = hashlib.sha256(f"{tool_name}\\0{text}".encode("utf-8")).hexdigest()[:32]
    shown = text if len(text) <= _SHOWN else text[:_SHOWN] + " …"
    return {
        "action": "approve",
        "message": shown,
        "rule_key": f"agentpier:{tool_name}:{digest}",
    }


def register(ctx):
    ctx.register_hook("pre_tool_call", _guard)
`;

/** The guard plugin's files, by path inside the Hermes home. */
export const guardFiles = Object.freeze({
  [`${guardDirectory}/plugin.yaml`]: manifest,
  [`${guardDirectory}/__init__.py`]: source,
});
