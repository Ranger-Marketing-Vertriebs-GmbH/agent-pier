// How the native session binding hooks into Claude Code: identity, activity and live
// reply plugins, plus the activity its hooks and transcript report.
import path from "node:path";
import { claudeInterruptAt } from "../../sessions/claude-interrupt.js";
import {
  claudeHookActivity,
  recordClaudeInterrupt,
} from "../../sessions/native-session-activity.js";

// Claude Code added the MessageDisplay hook event in this release.
export const MESSAGE_DISPLAY_VERSION = "2.1.152";

/** A missing session id in a hook payload is an error. */
export const idOptional = false;

/**
 * Passes `--session-id <id>` unless the launch resumes or names one, and adds three
 * plugins below `directory`, each with its own `--plugin-dir`: `<id>.claude` (identity
 * hooks), `<id>.claude-activity` (asynchronous activity hooks) and, from
 * MESSAGE_DISPLAY_VERSION on (`atLeast(cliVersion, minimum)`), `<id>.claude-stream`
 * (live reply text). Every hook runs `script --record`; `ensureDir`, `write(file,
 * value)` and `quote(value)` come from the caller.
 */
export function addHooks(
  launch,
  { id, directory: root, script, cliVersion, atLeast, ensureDir, write, quote },
) {
  const { args } = launch;
  const hook = {
    hooks: [
      {
        type: "command",
        command: [process.execPath, script, "--record"].map(quote).join(" "),
        timeout: 5,
      },
    ],
  };
  if (!args.includes("--session-id") && !args.includes("--resume"))
    args.push("--session-id", id);
  // Capture /clear and native resume events as well as the explicitly assigned launch ID.
  const directory = path.join(root, `${id}.claude`);
  ensureDir(path.join(directory, ".claude-plugin"));
  ensureDir(path.join(directory, "hooks"));
  write(path.join(directory, ".claude-plugin/plugin.json"), {
    name: "agentpier-reader",
    version: "1.0.0",
    description: "Native session identity for the AgentPier reader",
  });
  write(path.join(directory, "hooks/hooks.json"), {
    hooks: { SessionStart: [hook], UserPromptSubmit: [hook] },
  });
  args.push("--plugin-dir", directory);
  // Activity hooks live in their own plugin: a Claude Code release that rejects
  // a newer event must not lose the identity hooks above.
  const activity = path.join(root, `${id}.claude-activity`);
  ensureDir(path.join(activity, ".claude-plugin"));
  ensureDir(path.join(activity, "hooks"));
  write(path.join(activity, ".claude-plugin/plugin.json"), {
    name: "agentpier-activity",
    version: "1.0.0",
    description: "Native session activity for AgentPier",
  });
  const observe = { hooks: [{ ...hook.hooks[0], async: true }] };
  write(path.join(activity, "hooks/hooks.json"), {
    hooks: {
      Stop: [observe],
      StopFailure: [observe],
      PermissionRequest: [observe],
      PreToolUse: [{ matcher: "AskUserQuestion", ...observe }],
      Elicitation: [observe],
      SessionEnd: [observe],
    },
  });
  args.push("--plugin-dir", activity);
  // Live reply text, in a plugin of its own: a release without MessageDisplay
  // must not lose the hooks above, and an unknown version keeps today's chat.
  // Asynchronous, so the TUI never waits for AgentPier to show a line.
  if (atLeast(cliVersion, MESSAGE_DISPLAY_VERSION)) {
    const stream = path.join(root, `${id}.claude-stream`);
    ensureDir(path.join(stream, ".claude-plugin"));
    ensureDir(path.join(stream, "hooks"));
    write(path.join(stream, ".claude-plugin/plugin.json"), {
      name: "agentpier-stream",
      version: "1.0.0",
      description: "Live reply text for the AgentPier chat",
    });
    write(path.join(stream, "hooks/hooks.json"), {
      hooks: { MessageDisplay: [observe] },
    });
    args.push("--plugin-dir", stream);
  }
}

/**
 * The activity report, ended like a hook would when Claude's transcript shows an Esc
 * interrupt after a reported running turn (Claude Code sends no hook for it). `ctx` is
 * the NativeSessionBinding (history, resolve, file, activity).
 */
export async function reportedActivity(ctx, session, activity) {
  if (!ctx.history || !["working", "waiting"].includes(activity?.state)) return activity;
  try {
    const id = (await ctx.resolve(session))?.id;
    if (!id) return activity;
    const file = await ctx.history.claudeFile(session, id);
    const at = await claudeInterruptAt(file, activity.at);
    if (at === null) return activity;
    recordClaudeInterrupt(ctx.file(session.id), at);
    return ctx.activity(session);
  } catch {
    return activity;
  }
}

/** The activity one Claude Code hook payload reports, or null. */
export const hookActivity = claudeHookActivity;
