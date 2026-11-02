import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { definitions, toolTimeouts } from "../../../team-plugin/index.js";

// The AgentPier team plugin of a Hermes agent (ADR 0006 decision 4): AgentPier's team
// tools and its tool guard in one Hermes profile plugin (website/docs/user-guide/
// features/plugins.md). Both answer through AgentPier's team bridge (team-bridge.js),
// as the OpenClaw team plugin does (../../../team-plugin/).
//
// - Tools: `ctx.register_tool` with the OpenClaw names (agentpier_team_*), so the
//   agent's instructions name them alike. A plugin tool's handler receives the calling
//   session's `session_id` (Hermes v0.22.5 model_tools.py `handle_function_call`; the
//   stored session id the session keys carry, tui_gateway/agent_factory.py) and runs
//   under the tool call's id (tools/approval_context.py `_approval_tool_call_id`). An
//   MCP call carries neither (tools/mcp_tool_handlers.py `call_tool` sends only the
//   arguments), so the tools are no MCP server. A call prepares a ticket for its
//   session and waits inside the tool for the answer: asks and proposals wait up to
//   about two minutes, beyond Hermes's 30-second hook timeout.
// - Guard: a `pre_tool_call` hook (hermes_cli/plugins.py `invoke_lifecycle_hook`, 30
//   s timeout, fail-closed) asks the bridge before a team member changes a file
//   (`write_file`, `patch`) and before every browser call (`browser_*`); no answer
//   blocks the call. Invisible subagents (`delegate_task`) run under a session of
//   their own; the `subagent_start` hook maps it to the parent's, so the guard judges
//   a subagent's call as its parent's. Team tools stay with the parent's own session.
//
// The bridge's address and token change with every AgentPier start. They live in
// bridge.json, which the plugin reads at each call, so a new one needs no restart.

export const teamPlugin = "agentpier-team";
export const teamDirectory = `plugins/${teamPlugin}`;
/** Home paths whose change the running gateway reads without a restart. */
export const liveTeamFiles = Object.freeze([`${teamDirectory}/bridge.json`]);

const prefix = "agentpier_team_";

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


def _session_key(session_id):
    if not isinstance(session_id, str) or not session_id:
        return None
    return "agent:" + _read("bridge.json")["agentId"] + ":hermes:" + session_id


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


def _tool(action, timeout):
    def handler(args, session_id=None, **_):
        try:
            key = _session_key(session_id)
            if key is None:
                raise _Refused(_UNAVAILABLE)
            prepared = _post(
                "/prepare",
                {
                    "agentId": _read("bridge.json")["agentId"],
                    "sessionKey": key,
                    "toolCallId": _call_id(),
                    "action": action,
                },
                10,
            )
            result = _post(
                "/invoke",
                {
                    "ticket": prepared["ticket"],
                    "action": action,
                    "input": args if isinstance(args, dict) else {},
                },
                timeout,
            )
            return json.dumps(result)
        except _Refused as refusal:
            return json.dumps({"error": str(refusal)})
        except Exception:
            return json.dumps({"error": _UNAVAILABLE})

    return handler


def _guard(tool_name="", args=None, session_id=None, **_):
    settings = _read("tools.json")
    browser = tool_name.startswith("browser_") and settings.get("browser")
    if not browser and not (tool_name in _WRITES and settings.get("guardWrites")):
        return None
    try:
        key = _session_key(_root(session_id))
        answer = _post(
            "/hermes-guard",
            {
                "agentId": _read("bridge.json")["agentId"],
                **({"sessionKey": key} if key else {}),
                "toolName": tool_name,
                "args": args if isinstance(args, dict) else {},
            },
            10,
        )
    except Exception:
        answer = None
    if isinstance(answer, dict) and answer.get("allow") is True:
        return None
    message = answer.get("message") if isinstance(answer, dict) else None
    return {"action": "block", "message": message or _GUARD_UNAVAILABLE}


def _subagent(parent_session_id=None, child_session_id=None, **_):
    if isinstance(parent_session_id, str) and isinstance(child_session_id, str):
        with _LOCK:
            _PARENTS[child_session_id] = parent_session_id


def register(ctx):
    settings = _read("tools.json")
    for tool in settings.get("tools", []):
        ctx.register_tool(
            name=tool["name"],
            toolset="agentpier",
            schema={
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
            handler=_tool(tool["action"], tool["timeoutMs"] / 1000),
            description=tool["description"],
        )
    ctx.register_hook("pre_tool_call", _guard)
    ctx.register_hook("subagent_start", _subagent)
`;

/** The team tools of `agent` (a desiredAgent) as `{ name, action }`, sorted. */
export function teamTools(agent) {
  if (agent.locked || agent.archived) return [];
  const names = agent.tools
    .filter((grant) => grant.needs?.includes("teams"))
    .flatMap((grant) => grant.tools || [])
    .filter((name) => name.startsWith(prefix));
  return [...new Set(names)]
    .map((name) => ({ name, action: name.slice(prefix.length) }))
    .filter(({ action }) => Object.hasOwn(definitions, action))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The plugin's files for `agent` (a desiredAgent), by path inside the home, or null
 * when it needs none. `connection`: the team bridge's `{ url, token }`, without which
 * the agent gets neither tools nor the guard; `browser`: whether it uses the browser;
 * `skills`: the built-in skills it gets (skills.js builtInOffered), copied here.
 * A team member's file changes ask the bridge (guardWrites), as the OpenClaw guard
 * does for every agent; an own agent's stay Hermes's own.
 */
export function teamPluginFiles(
  agent,
  { connection, browser = false, skills = [] } = {},
) {
  if (!connection?.url || !connection?.token) return null;
  const tools = teamTools(agent).map(({ name, action }) => ({
    name,
    action,
    description: definitions[action].description,
    parameters: definitions[action].parameters,
    timeoutMs: toolTimeouts[action] ?? 10000,
  }));
  const guardWrites = agent.team.memberOf !== null;
  if (!tools.length && !guardWrites && !browser) return null;
  const settings = { tools, guardWrites, browser: !!browser };
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
    [`${teamDirectory}/tools.json`]: `${JSON.stringify(settings, null, 2)}\n`,
    [`${teamDirectory}/bridge.json`]: `${JSON.stringify(bridge, null, 2)}\n`,
  };
}
