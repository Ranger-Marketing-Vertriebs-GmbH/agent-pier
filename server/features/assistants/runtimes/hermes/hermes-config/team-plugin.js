import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  browserStageTimeoutMs,
  definitions,
  toolName,
  toolTimeouts,
} from "../../../team-plugin/index.js";
import { pdfToolFile, pdfToolSource } from "./pdf.js";

// The AgentPier team plugin of a Hermes agent (ADR 0006 decision 4): AgentPier's team
// tools and its tool guard in one Hermes profile plugin (website/docs/user-guide/
// features/plugins.md). Both answer through AgentPier's team bridge (team-bridge.js),
// as the OpenClaw team plugin does (../../../team-plugin/).
//
// - Tools: `ctx.register_tool` with the OpenClaw names (AgentPier's own agentpier_*
//   tools and the team tools agentpier_team_*), so the agent's instructions name
//   them alike. A plugin tool's handler receives the calling
//   session's `session_id` (Hermes v0.22.5 model_tools.py `handle_function_call`; the
//   stored session id the session keys carry, tui_gateway/agent_factory.py) and runs
//   under the tool call's id (tools/approval_context.py `_approval_tool_call_id`). An
//   MCP call carries neither (tools/mcp_tool_handlers.py `call_tool` sends only the
//   arguments), so the tools are no MCP server. A call prepares a ticket for its
//   session and waits inside the tool for the answer: asks and proposals wait up to
//   about two minutes, beyond Hermes's 30-second hook timeout.
// - Guard: a `pre_tool_call` hook (hermes_cli/plugins.py `invoke_lifecycle_hook`,
//   fail-closed) asks the bridge before a team member changes a file (`write_file`,
//   `patch`), before a file call that names the attachments/ or .agentpier/ folder
//   (`read_file`, `search_files`, `vision_analyze`, the writes) and before every
//   browser call (`browser_*`) and image creation (`image_generate`); no answer
//   blocks the call. AgentPier's pdf tool (pdf.js) asks the same bridge at each call.
//   Invisible subagents (`delegate_task`) run under a session of
//   their own; the `subagent_start` hook maps it to the parent's, so the guard judges
//   a subagent's call as its parent's. Team tools stay with the parent's own session.
// - Images: a `transform_tool_result` hook (model_tools.py) copies an image Hermes
//   created (agent/image_gen_provider.py `save_b64_image`, below the home's
//   cache/generated/images/) into the agent's folder and shares it into the chat with
//   agentpier_share_file, as OpenClaw's generated images reach the chat
//   (generated-images.js): the agent does nothing for it.
//
// The bridge's address and token change with every AgentPier start. They live in
// bridge.json, which the plugin reads at each call, so a new one needs no restart.

export const teamPlugin = "agentpier-team";
export const teamDirectory = `plugins/${teamPlugin}`;
/** Home paths whose change the running gateway reads without a restart. */
export const liveTeamFiles = Object.freeze([`${teamDirectory}/bridge.json`]);

// AgentPier's built-in skills ship with the OpenClaw team plugin (built-in-skills.js);
// a Hermes home carries its own copy inside this plugin's folder.
const shippedSkill = (name) =>
  fs.readFileSync(
    fileURLToPath(
      new URL(`../../../team-plugin/skills/${name}/SKILL.md`, import.meta.url),
    ),
    "utf8",
  );
const skillTexts = new Map();
// Hermes's browser tools have no upload (tools/browser_tool.py), so an agent with
// AgentPier's browser gets this tool (hermes-browser-upload.js).
const browserUpload = Object.freeze({
  name: "agentpier_browser_upload",
  description:
    "Put files into a file field (input type=file) of a page open in your browser, as a person choosing files would. First call agentpier_workspace with action browser_upload_stage for each file (path, and projectId for a project folder) and pass the uploadPath values it returns as paths, unchanged; nothing else can be uploaded, and a staged file expires after six hours. selector: a CSS selector of the file field (default: the page's first input[type=file]). urlContains: part of the page's address when several pages are open. Then take a snapshot and submit the form with your browser tools.",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 4096 },
      },
      selector: { type: "string", minLength: 1, maxLength: 1000 },
      urlContains: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["paths"],
    additionalProperties: false,
  },
});

/** The folder of the agent's own folder its generated images are shared from. */
export const generatedImagesFolder = "generated-images";

/** The folder below HERMES_HOME that holds built-in skill `name`. */
export const teamSkillFolder = (name) => `${teamDirectory}/skills/${name}`;

const manifest = `name: ${teamPlugin}
version: "1"
description: AgentPier team tools and tool guard
`;

const source = `"""AgentPier team tools and tool guard for this agent.

Written by AgentPier into this agent's Hermes home; AgentPier replaces it on every
configuration change. Every call asks AgentPier's team bridge (bridge.json); a call it
cannot answer fails, and the guard then blocks the tool.
"""

import json
import os
import re
import shutil
import threading
import urllib.error
import urllib.request
import uuid

_DIR = os.path.dirname(os.path.abspath(__file__))
_UNAVAILABLE = "AgentPier operation unavailable; inspect its state before retrying."
_GUARD_UNAVAILABLE = "AgentPier is not reachable right now; try again shortly."
# Loopback only: the host's proxy settings never apply to the bridge.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# Invisible subagents (delegate_task): child session id -> parent session id.
_PARENTS = {}
_LOCK = threading.Lock()
_WRITES = ("write_file", "patch")
# File tools whose paths may name the agent's attachments/ or secrets folder.
_FILES = ("read_file", "search_files", "vision_analyze") + _WRITES


class _Refused(Exception):
    pass


def _read(name):
    with open(os.path.join(_DIR, name), encoding="utf-8") as handle:
        return json.load(handle)


def _post(endpoint, body, timeout):
    bridge = _read("bridge.json")
    request = urllib.request.Request(
        bridge["url"] + endpoint,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "authorization": "Bearer " + bridge["token"],
            "content-type": "application/json",
        },
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as error:
        # AgentPier names a stable code and a fixed reason; anything else is a
        # transport failure.
        try:
            answer = json.loads(error.read().decode("utf-8"))
        except Exception:
            answer = None
        if (
            isinstance(answer, dict)
            and isinstance(answer.get("error"), str)
            and isinstance(answer.get("reason"), str)
            and answer["error"] != "UNAVAILABLE"
        ):
            raise _Refused(answer["error"] + ": " + answer["reason"])
        raise _Refused(_UNAVAILABLE)
    except Exception:
        raise _Refused(_UNAVAILABLE)


# A routine run's tool calls carry its task id cron:<job>:<execution>
# (cron/scheduler.py); older runs named their session cron_<job>_<YYYYmmdd_HHMMSS>.
# AgentPier keys such a run by its job (hermes-routine-jobs.js runSessionKey).
_CRON_TASK = re.compile(r"^cron:([A-Za-z0-9_-]{1,64}):")
_CRON = re.compile(r"^cron_([A-Za-z0-9-]{1,64})_[0-9]{8}_[0-9]{6}$")


def _job(session_id, task_id):
    match = _CRON_TASK.match(task_id or "") or _CRON.match(session_id or "")
    return match.group(1) if match else None


def _session_key(session_id, task_id=None):
    if not isinstance(session_id, str) or not session_id:
        return None
    prefix = "agent:" + _read("bridge.json")["agentId"] + ":hermes:"
    job = _job(session_id, task_id)
    if job:
        return prefix + "cron:" + job + ":" + session_id
    return prefix + session_id


def _segments(session_id):
    # A compression continues a chat in a new stored session (end_reason
    # "compression" on its parent); AgentPier may still key the chat by an earlier
    # segment until it is opened again. Newest first, through compressions only (never
    # a subagent's parent), read through Hermes's shared SessionDB in this process.
    ids = [session_id]
    try:
        from hermes_state_registry import acquire, release_or_close

        db = acquire()
        try:
            current = session_id
            for _ in range(200):
                row = db.get_session(current)
                parent = row.get("parent_session_id") if row else None
                above = db.get_session(parent) if parent else None
                if not above or above.get("end_reason") != "compression" or parent in ids:
                    break
                ids.append(parent)
                current = parent
        finally:
            release_or_close(db)
    except Exception:
        pass
    return ids


def _root(session_id):
    with _LOCK:
        seen = set()
        while session_id in _PARENTS and session_id not in seen:
            seen.add(session_id)
            session_id = _PARENTS[session_id]
    return session_id


def _call_id():
    try:
        from tools.approval_context import _approval_tool_call_id

        value = _approval_tool_call_id.get()
        if value:
            return str(value)
    except Exception:
        pass
    return "hermes-" + uuid.uuid4().hex


def _timeout(tool, args):
    if tool["action"] == "workspace" and args.get("action") == "browser_upload_stage":
        return tool["stageTimeoutMs"] / 1000
    return tool["timeoutMs"] / 1000


def _shown(action, result):
    # A project image (workspace image_view) is named, never returned as base64 text:
    # a plugin tool answers text only.
    if (
        action == "workspace"
        and isinstance(result, dict)
        and isinstance(result.get("data"), str)
        and isinstance(result.get("mimeType"), str)
    ):
        result = {key: value for key, value in result.items() if key != "data"}
        result["note"] = "Image content is not shown to this agent; read the file instead."
    return json.dumps(result)


def _tool(tool):
    action = tool["action"]

    def handler(args, session_id=None, task_id=None, **_):
        try:
            if _session_key(session_id) is None:
                raise _Refused(_UNAVAILABLE)
            call_id = _call_id()
            if _job(session_id, task_id):
                keys = [_session_key(session_id, task_id)]
            else:
                keys = [_session_key(sid) for sid in _segments(session_id)]
            prepared = None
            for index, key in enumerate(keys):
                try:
                    prepared = _post(
                        "/prepare",
                        {
                            "agentId": _read("bridge.json")["agentId"],
                            "sessionKey": key,
                            "toolCallId": call_id,
                            "action": action,
                        },
                        10,
                    )
                    break
                except _Refused:
                    # The chat's earlier segment, as AgentPier may still key it.
                    if index == len(keys) - 1:
                        raise
            args = args if isinstance(args, dict) else {}
            result = _post(
                "/invoke",
                {"ticket": prepared["ticket"], "action": action, "input": args},
                _timeout(tool, args),
            )
            return _shown(action, result)
        except _Refused as refusal:
            return json.dumps({"error": str(refusal)})
        except Exception:
            return json.dumps({"error": _UNAVAILABLE})

    return handler


def _names_folder(args):
    # A cheap first look: only a call whose arguments name attachments/ or .agentpier/
    # in some spelling asks AgentPier, which resolves the paths itself.
    try:
        text = json.dumps(args).lower()
    except Exception:
        return True
    return "attachments" in text or ".agentpier" in text or "%" in text


def _ask(tool_name, args, session_id, task_id, member_write=False):
    # The bridge's answer for one call, or None when it cannot answer.
    try:
        root = _root(session_id)
        key = _session_key(root, task_id)
        cron = _job(root, task_id)
        earlier = [_session_key(sid) for sid in _segments(root)[1:]] if key and not cron else []
        return _post(
            "/hermes-guard",
            {
                "agentId": _read("bridge.json")["agentId"],
                **({"sessionKey": key} if key else {}),
                **({"segments": earlier[:20]} if earlier else {}),
                "toolName": tool_name,
                "args": args,
                **({"memberWrite": True} if member_write else {}),
            },
            10,
        )
    except Exception:
        return None


def _guard(tool_name="", args=None, session_id=None, task_id=None, **_):
    settings = _read("tools.json")
    args = args if isinstance(args, dict) else {}
    browser = tool_name.startswith("browser_") and settings.get("browser")
    member_write = tool_name in _WRITES and bool(settings.get("guardWrites"))
    folder = tool_name in _FILES and _names_folder(args)
    image = tool_name == "image_generate" and bool(settings.get("images"))
    if not browser and not member_write and not folder and not image:
        return None
    answer = _ask(tool_name, args, session_id, task_id, member_write)
    if isinstance(answer, dict) and answer.get("allow") is True:
        return None
    message = answer.get("message") if isinstance(answer, dict) else None
    return {"action": "block", "message": message or _GUARD_UNAVAILABLE}


def _subagent(parent_session_id=None, child_session_id=None, **_):
    if isinstance(parent_session_id, str) and isinstance(child_session_id, str):
        with _LOCK:
            _PARENTS[child_session_id] = parent_session_id


# Where Hermes saves the images it creates (agent/image_gen_provider.py).
_GENERATED = os.path.join(os.path.dirname(os.path.dirname(_DIR)), "cache", "generated", "images")
_SHARE = _tool({"action": "share_file", "timeoutMs": 30000})


def _image_result(tool_name="", result=None, session_id=None, task_id=None, **_):
    # Hands an image Hermes created to the chat as a file of the agent's own folder.
    images = _read("tools.json").get("images")
    if tool_name != "image_generate" or not images or not isinstance(result, str):
        return None
    try:
        answer = json.loads(result)
        if not isinstance(answer, dict) or answer.get("success") is not True:
            return None
        source = os.path.realpath(str(answer.get("image") or ""))
        if not source.startswith(os.path.realpath(_GENERATED) + os.sep):
            return None
        if not os.path.isfile(source):
            return None
        name = os.path.basename(source)
        os.makedirs(os.path.join(images["folder"], images["share"]), mode=0o700, exist_ok=True)
        target = os.path.join(images["folder"], images["share"], name)
        shutil.copyfile(source, target)
    except Exception:
        return None
    relative = images["share"] + "/" + name
    try:
        shared = json.loads(_SHARE({"path": relative}, session_id=_root(session_id), task_id=task_id))
    except Exception:
        shared = {"error": _UNAVAILABLE}
    answer["image"] = target
    if isinstance(shared, dict) and shared.get("status") == "shared":
        answer["note"] = (
            "AgentPier handed this image over in this chat. "
            + str(shared.get("note") or "")
            + " Do not share it again with agentpier_share_file."
        ).strip()
    else:
        error = shared.get("error") if isinstance(shared, dict) else None
        answer["note"] = (
            "AgentPier could not hand this image over ("
            + str(error or _UNAVAILABLE)
            + "). Share " + relative + " with agentpier_share_file."
        )
    return json.dumps(answer)


def _upload(args, session_id=None, task_id=None, **_):
    # Fills a page's file field in this agent's AgentPier browser with files
    # AgentPier staged for it; AgentPier checks and audits every call.
    try:
        key = _session_key(_root(session_id), task_id)
        args = args if isinstance(args, dict) else {}
        body = {"agentId": _read("bridge.json")["agentId"], "paths": args.get("paths")}
        if key:
            body["sessionKey"] = key
        for name in ("selector", "urlContains"):
            if isinstance(args.get(name), str):
                body[name] = args[name]
        return json.dumps(_post("/hermes-browser-upload", body, 30))
    except _Refused as refusal:
        return json.dumps({"error": str(refusal)})
    except Exception:
        return json.dumps({"error": _UNAVAILABLE})


def _pdf_tool(pdf):
    # AgentPier's pdf tool (pdf_tool.py beside this file); every call asks the guard.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "agentpier_team_pdf_tool", os.path.join(_DIR, "pdf_tool.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.handler(
        pdf, lambda args, session_id, task_id: _ask("pdf", args, session_id, task_id)
    )


def register(ctx):
    settings = _read("tools.json")
    pdf = settings.get("pdf")
    if pdf:
        ctx.register_tool(
            name=pdf["name"],
            toolset="agentpier",
            schema={
                "name": pdf["name"],
                "description": pdf["description"],
                "parameters": pdf["parameters"],
            },
            handler=_pdf_tool(pdf),
            description=pdf["description"],
        )
    upload = settings.get("browserUpload")
    if upload:
        ctx.register_tool(
            name=upload["name"],
            toolset="agentpier",
            schema=upload,
            handler=_upload,
            description=upload["description"],
        )
    for tool in settings.get("tools", []):
        ctx.register_tool(
            name=tool["name"],
            toolset="agentpier",
            schema={
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
            handler=_tool(tool),
            description=tool["description"],
        )
    ctx.register_hook("pre_tool_call", _guard)
    ctx.register_hook("subagent_start", _subagent)
    if settings.get("images"):
        ctx.register_hook("transform_tool_result", _image_result)
`;

// The bridge action a tool name stands for, or null (team-plugin/index.js toolName).
const actionOf = (name) => {
  const action = name.replace(/^agentpier_(?:team_)?/, "");
  return action !== name &&
    Object.hasOwn(definitions, action) &&
    toolName(action) === name
    ? action
    : null;
};

/**
 * AgentPier's bridge tools of `agent` (a desiredAgent) as `{ name, action }`, sorted:
 * its team tools and AgentPier's own tools (reminders, routines, hooks, workspace,
 * file sharing, SSH, goals, coding sessions, mail, projects, previews), as its grants
 * name them (native-capabilities.js toolGrants, which already leaves out what a user
 * agent may not hold). The bridge checks every call as it does OpenClaw's.
 */
export function teamTools(agent) {
  if (agent.archived) return [];
  const names = agent.tools.flatMap((grant) => grant.tools || []);
  return [...new Set(names)]
    .map((name) => ({ name, action: actionOf(name) }))
    .filter(({ action }) => action)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The plugin's files for `agent` (a desiredAgent), by path inside the home, or null
 * when it needs none. `connection`: the team bridge's `{ url, token }`, without which
 * the agent gets neither tools nor the guard; `browser`: whether it uses the browser;
 * `skills`: the built-in skills it gets (skills.js builtInOffered), copied here;
 * `images`: `{ folder }`, the agent's own folder, while it creates images (images.js),
 * which its generated images are copied into before they are shared; `pdf`: the
 * pdf tool's settings while it reads PDFs (pdf.js pdfHome).
 * A team member's file changes ask the bridge (guardWrites), as the OpenClaw guard
 * does for every agent; an own agent's stay Hermes's own.
 */
export function teamPluginFiles(
  agent,
  { connection, browser = false, skills = [], images = null, pdf = null } = {},
) {
  if (!connection?.url || !connection?.token) return null;
  const tools = teamTools(agent).map(({ name, action }) => ({
    name,
    action,
    description: definitions[action].description,
    parameters: definitions[action].parameters,
    timeoutMs: toolTimeouts[action] ?? 10000,
    ...(action === "workspace" && { stageTimeoutMs: browserStageTimeoutMs }),
  }));
  const guardWrites = agent.team.memberOf !== null;
  const settings = {
    tools,
    guardWrites,
    browser: !!browser,
    ...(browser && { browserUpload }),
    ...(images?.folder && {
      images: { folder: images.folder, share: generatedImagesFolder },
    }),
    ...(pdf && { pdf }),
  };
  const bridge = {
    url: connection.url,
    token: connection.token,
    agentId: agent.runtimeAgentId,
  };
  const skillFiles = Object.fromEntries(
    skills.map((name) => {
      if (!skillTexts.has(name)) skillTexts.set(name, shippedSkill(name));
      return [`${teamSkillFolder(name)}/SKILL.md`, skillTexts.get(name)];
    }),
  );
  return {
    ...skillFiles,
    [`${teamDirectory}/plugin.yaml`]: manifest,
    [`${teamDirectory}/__init__.py`]: source,
    ...(pdf && { [`${teamDirectory}/${pdfToolFile}`]: pdfToolSource() }),
    [`${teamDirectory}/tools.json`]: `${JSON.stringify(settings, null, 2)}\n`,
    [`${teamDirectory}/bridge.json`]: `${JSON.stringify(bridge, null, 2)}\n`,
  };
}
