import { teamDirectory } from "./team-plugin.js";

// The AgentPier guard: a Hermes profile plugin (website/docs/user-guide/features/
// plugins.md) with one `pre_tool_call` hook and two jobs.
//
// - Every command (`everyCommand`): in a chat it returns `{"action": "approve"}` for
//   every shell command, Python run and input to a running process, so each asks the
//   owner (website/docs/user-guide/features/hooks.md; tools/approval.py
//   `request_tool_approval`). The message carries the command itself: Hermes shows the
//   call only as "<terminal> (plugin approval rule)" (Hermes runtime spike). The rule
//   key hashes the exact text, so "always" allows that one command again, never every
//   command of the tool (an empty key would hash only the message). A shell command
//   Hermes itself flags as dangerous is left to Hermes's own check, which asks after
//   the plugin hook: asking in both would put the same command to the owner twice.
// - Routine runs (`cronAsks`): Hermes asks nobody in a cron run (tools/approval.py
//   `_presence` clears every surface while HERMES_CRON_SESSION is set) and decides by
//   `approvals.cron_mode`. With `cron_mode: approve` (home.js) the hook asks the owner
//   itself, through AgentPier's team bridge (`/hermes-approval`,
//   hermes-routine-approvals.js), and waits: an allow lets the call run, anything
//   else blocks it. It asks for every action that mode would let through unasked: a
//   shell command Hermes flags as dangerous (tools/approval_detection.py), every
//   execute_code run (tools/approval.py check_execute_code_guard), a write to the
//   SSH client config (tools/file_tools_write_guards.py
//   _check_approval_required_write), and on every-command also every other shell
//   command and process input. Hardline commands stay Hermes's own floor, which
//   blocks them whatever the mode. The bridge address is the team plugin's
//   bridge.json, read at each call; without it, or without an answer, the call is
//   blocked.

export const guardPlugin = "agentpier-guard";
export const guardDirectory = `plugins/${guardPlugin}`;
/**
 * How long the hook may wait for the owner (`plugins.hook_callback_timeout`, seconds;
 * Hermes clamps it to 600, hermes_cli/plugins_dispatch.py): AgentPier's question
 * waits 300 seconds (hermes-approval-queue.js askTimeoutMs), the request a little
 * longer. Every other hook keeps its own shorter budget (the team guard's 10 s).
 */
export const guardHookTimeoutS = 330;

const manifest = `name: ${guardPlugin}
version: "1"
description: AgentPier asks the owner before shell commands and Python runs
`;

const source = `"""AgentPier guard: asks the owner before shell commands and Python runs.

Written by AgentPier into this agent's Hermes home; AgentPier replaces it on every
configuration change.
"""

import hashlib
import json
import os
import re
import threading
import urllib.request

try:
    # Hermes's own check (tools/approval.py check_dangerous_command) asks before the
    # shell commands it flags as dangerous; the guard leaves those to it, so such a
    # command asks the owner once, with Hermes's reason, instead of twice.
    from tools.approval_detection import detect_dangerous_command as _dangerous
except Exception:  # A Hermes without it: the guard asks for every command itself.
    _dangerous = None

_DIR = os.path.dirname(os.path.abspath(__file__))
_BRIDGE = os.path.join(_DIR, "..", "${teamDirectory.split("/").at(-1)}", "bridge.json")
# The argument that holds what the tool runs.
_RUNS = {"terminal": "command", "execute_code": "code"}
# process_manage actions that send input to a running process.
_INPUT = {"write", "submit"}
# Longer texts are shortened in the approval card; the rule key covers all of it.
_SHOWN = 4000
# AgentPier waits 300 s for the owner; the request a little longer.
_WAIT = 320
_REFUSED = "BLOCKED: AgentPier could not ask the owner about this command; do not retry it in this run."
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_CRON_TASK = re.compile(r"^cron:([A-Za-z0-9_-]{1,64}):")
_CRON_SESSION = re.compile(r"^cron_([A-Za-z0-9-]{1,64})_\\d{8}_\\d{6}$")
_PATCH_PATH = re.compile(r"^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$|^\\*\\*\\* Move to: (.+)$", re.M)
# Invisible subagents (delegate_task): child session id -> parent session id; and the
# job each cron run session belongs to.
_PARENTS = {}
_JOBS = {}
_LOCK = threading.Lock()


def _settings():
    with open(os.path.join(_DIR, "guard.json"), encoding="utf-8") as handle:
        return json.load(handle)


def _text(tool_name, args):
    if tool_name in _RUNS:
        return str(args.get(_RUNS[tool_name]) or "")
    if tool_name == "process_manage" and args.get("action") in _INPUT:
        target = args.get("session_id") or ""
        return f"{args.get('action')} {target}: {args.get('data') or ''}"
    return None


def _flagged(tool_name, text):
    if tool_name != "terminal" or _dangerous is None:
        return False
    try:
        return bool(_dangerous(text)[0])
    except Exception:
        return False


def _chat_guard(tool_name, args):
    text = _text(tool_name, args)
    if text is None or _flagged(tool_name, text):
        return None
    digest = hashlib.sha256(f"{tool_name}\\0{text}".encode("utf-8")).hexdigest()[:32]
    shown = text if len(text) <= _SHOWN else text[:_SHOWN] + " …"
    return {
        "action": "approve",
        "message": shown,
        "rule_key": f"agentpier:{tool_name}:{digest}",
    }


def _in_cron():
    try:
        from tools.approval_context import _is_cron_approval_context

        return bool(_is_cron_approval_context())
    except Exception:
        return str(os.environ.get("HERMES_CRON_SESSION", "")).lower() in ("1", "true", "yes")


def _root(session_id):
    with _LOCK:
        seen = set()
        while session_id in _PARENTS and session_id not in seen:
            seen.add(session_id)
            session_id = _PARENTS[session_id]
    return session_id


def _job(session_id, task_id):
    match = _CRON_TASK.match(task_id or "")
    if match and session_id:
        with _LOCK:
            _JOBS[session_id] = match.group(1)
    with _LOCK:
        if session_id in _JOBS:
            return _JOBS[session_id]
    match = _CRON_SESSION.match(session_id or "")
    return match.group(1) if match else None


def _write_paths(tool_name, args):
    if tool_name == "write_file" or (tool_name == "patch" and args.get("mode") != "patch"):
        return [str(args.get("path") or "")]
    if tool_name == "patch":
        return [a or b for a, b in _PATCH_PATH.findall(str(args.get("patch") or ""))]
    return []


def _ssh_config(paths, task_id):
    try:
        from agent.file_safety import is_write_approval_required
    except Exception:
        return False  # Hermes's own write gate is missing as well.
    try:
        from tools.file_tools_write_guards import _resolved_or_raw
    except Exception:
        _resolved_or_raw = lambda path, _task: os.path.abspath(os.path.expanduser(path))
    for path in paths:
        try:
            if is_write_approval_required(_resolved_or_raw(path.strip(), task_id or "default")):
                return True
        except Exception:
            return True
    return False


def _hardline(text):
    try:
        from tools.approval_detection import detect_hardline_command

        return bool(detect_hardline_command(text)[0])
    except Exception:
        return False


def _allowlisted(text):
    try:
        from tools.approval_floors import _command_matches_permanent_allowlist

        return bool(_command_matches_permanent_allowlist(text))
    except Exception:
        return False


# What a routine run asks the owner about: (kind, shown text, Hermes's reason), or None.
def _cron_question(tool_name, args, every, task_id):
    if tool_name in ("write_file", "patch"):
        paths = _write_paths(tool_name, args)
        if paths and _ssh_config(paths, task_id):
            return ("write", f"{tool_name} {', '.join(paths)}", "Write to the SSH client config")
        return None
    text = _text(tool_name, args)
    if text is None:
        return None
    if tool_name == "execute_code":
        return ("code", text, "execute_code script execution")
    if tool_name == "process_manage":
        return ("input", text, "") if every else None
    if _hardline(text) or _allowlisted(text):
        return None  # Hermes's floor blocks it; the owner's allowlist allows it.
    flagged = None
    if _dangerous is not None:
        try:
            found = _dangerous(text)
            flagged = found[2] if found[0] else None
        except Exception:
            flagged = "unrecognised command"
    if flagged is None and _dangerous is None:
        flagged = "unrecognised command"
    if flagged is None and not every:
        return None
    return ("command", text, flagged or "")


def _ask(question, session_id, task_id):
    kind, text, reason = question
    try:
        bridge = json.load(open(_BRIDGE, encoding="utf-8"))
        job = _job(_root(session_id), task_id)
        if not job:
            return _REFUSED
        key = f"agent:{bridge['agentId']}:hermes:cron:{job}:{_root(session_id)}"
        request = urllib.request.Request(
            bridge["url"] + "/hermes-approval",
            data=json.dumps({
                "agentId": bridge["agentId"],
                "sessionKey": key,
                "command": text,
                "description": reason,
                "kind": kind,
            }).encode("utf-8"),
            method="POST",
            headers={
                "authorization": "Bearer " + bridge["token"],
                "content-type": "application/json",
            },
        )
        with _OPENER.open(request, timeout=_WAIT) as response:
            answer = json.loads(response.read().decode("utf-8") or "null")
    except Exception:
        return _REFUSED
    if isinstance(answer, dict) and answer.get("allow") is True:
        return None
    message = answer.get("message") if isinstance(answer, dict) else None
    return message if isinstance(message, str) and message else _REFUSED


def _guard(tool_name="", args=None, session_id=None, task_id=None, **kwargs):
    args = args if isinstance(args, dict) else {}
    try:
        settings = _settings()
    except Exception:
        settings = None
    if not isinstance(settings, dict):
        # Fail closed: without its settings the guard cannot tell what to ask.
        if tool_name in ("terminal", "execute_code", "process_manage", "write_file", "patch"):
            return {"action": "block", "message": _REFUSED}
        return None
    every = settings.get("everyCommand") is True
    if settings.get("cronAsks") is True and _in_cron():
        _job(session_id or "", task_id or "")
        question = _cron_question(tool_name, args, every, task_id)
        if question is None:
            return None
        refusal = _ask(question, session_id or "", task_id or "")
        return None if refusal is None else {"action": "block", "message": refusal}
    return _chat_guard(tool_name, args) if every else None


def _subagent(parent_session_id=None, child_session_id=None, **_):
    if isinstance(parent_session_id, str) and isinstance(child_session_id, str):
        with _LOCK:
            _PARENTS[child_session_id] = parent_session_id


def register(ctx):
    ctx.register_hook("pre_tool_call", _guard)
    ctx.register_hook("subagent_start", _subagent)
`;

/**
 * The guard plugin's files, by path inside the Hermes home: `everyCommand` asks
 * before every command in chats, `cronAsks` asks the owner in routine runs through
 * the team bridge (the home then sets `approvals.cron_mode: approve`).
 */
export const guardFiles = ({ everyCommand = false, cronAsks = false } = {}) =>
  Object.freeze({
    [`${guardDirectory}/plugin.yaml`]: manifest,
    [`${guardDirectory}/__init__.py`]: source,
    [`${guardDirectory}/guard.json`]: `${JSON.stringify({ everyCommand, cronAsks }, null, 2)}\n`,
  });
