export const assistantBrowserCopy = {
  group: "Agent browser",
  visible: "Visible browser",
  visibleDescription:
    "Opens a regular, minimized browser window instead of an invisible one. Many shops and product pages block invisible browsers. To sign in, open the window from the Dock or the window list.",
  noApp:
    "Visible windows need a browser app of the agent's own, not your Chrome. Install it here with “Install browser”, or install Brave or Chromium yourself, then restart the agent service.",
  noDisplay:
    "This computer has no display (DISPLAY or WAYLAND_DISPLAY is missing), so the browser runs invisibly.",
  profile:
    "The browser keeps its sign-ins and cookies in a profile of this agent's own, apart from your browser profiles.",
  running: "Browser running",
  runningNow: "Now",
  install: "Install browser",
  installDescription:
    "Downloads Google's Chrome for Testing into AgentPier's own folder, checksum-verified. No Homebrew, no administrator rights.",
  restart: "Restart agent service",
  restartTitle: "Restart the agent service?",
  restartDescription:
    "A newly installed or removed browser applies only after the agent service restarts. Running work is not interrupted: while an agent is busy, the restart is refused.",
  restartConfirm: "Restart",
  liveTitle: "Browser",
  liveOpen: "Open live view",
  liveOpenDescription: "Shows the agent browser's window live, also while minimized.",
  liveStatus: {
    connecting: "Connecting …",
    live: "Live",
    stopped: "The browser is not running.",
    blocked: "This page may not be shown.",
    unavailable: "The live view is not available right now.",
  },
  liveReason: {
    service: "The agent service is not ready.",
    noProfile:
      "This agent has no browser profile. Switch on “Use a browser” and restart the agent service.",
    request: "The browser is not answering. Trying again.",
  },
  liveStart: "Start browser",
  liveTab: "Tab",
  liveFollow: "Follow the agent",
  liveNoImage: "No picture yet. It appears once the page changes.",
  livePrivacy: "Only you see this view. AgentPier stores no pictures.",
  livePreview: (name) => `Live view of ${name}'s browser`,
  reset: "Reset browser profile",
  resetDescription:
    "Stops the agent's browser and deletes its profile with every sign-in, cookie and its history.",
  resetConfirm: "Delete profile",
  resetTitle: "Reset the browser profile?",
  resetDone: "The browser profile was deleted.",
  resetFailed: "The browser profile could not be reset.",
};
