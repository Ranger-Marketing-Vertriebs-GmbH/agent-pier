import { shellQuote } from "../../lib/launch-serialization.js";

/** A detached mobile terminal can leave Claude's next dialog physically clipped. */
export async function prepareModelViewport(manager, target) {
  const clients = (
    await manager.tmux(["list-clients", "-t", target, "-F", "#{client_flags}"])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  // The chat stream itself attaches an ignore-size control client. It has no
  // visible terminal and must not keep the previous phone geometry in place.
  if (clients.some((flags) => !flags.split(",").includes("ignore-size"))) return false;
  const sizing = (await manager.tmux(["show-options", "-w", "-t", target, "window-size"]))
    .trim()
    .split(/\s+/)[1];
  const destination = shellQuote(target);
  const restore = sizing
    ? `set-option -w -t ${destination} window-size ${shellQuote(sizing)}`
    : `set-option -wu -t ${destination} window-size`;
  // Recheck attachment count in tmux before resizing, then restore normal sizing
  // so a browser or SSH terminal that attaches next determines its own geometry.
  const result = await manager.tmux([
    "if-shell",
    "-F",
    "-t",
    target,
    `#{&&:#{==:#{session_attached},${clients.length}},#{||:#{<:#{window_width},120},#{<:#{window_height},50}}}`,
    `resize-window -t ${destination} -x 120 -y 50; ${restore}; display-message -p resized`,
    "display-message -p unchanged",
  ]);
  return result.trim() === "resized";
}
