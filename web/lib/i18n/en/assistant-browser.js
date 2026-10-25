export const assistantBrowserCopy = {
  group: "Agent browser",
  visible: "Visible browser",
  visibleDescription:
    "Opens a regular browser window instead of an invisible one and moves it to the bottom-right corner of the screen, out of your way. Many shops and product pages block invisible browsers. To sign in, take over the browser in its live view, or drag the window in from the corner.",
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
  liveOpenDescription:
    "Shows the agent browser's window live, wherever it is on the screen.",
  liveStatus: {
    connecting: "Connecting …",
    live: "Live",
    stopped: "The browser is not running.",
    blocked: "This page may not be shown.",
    unavailable: "The live view is not available right now.",
  },
  liveReason: {
    noSlot: "This team member has no browser yet. It gets one as soon as it uses it.",
    service: "The agent service is not ready.",
    noProfile:
      "This agent has no browser profile. Switch on “Use a browser” and restart the agent service.",
    request: "The browser is not answering. Trying again.",
  },
  liveNotConnected:
    "The live view is not connected right now. Please try again in a moment.",
  liveEnded: "The live view ended. Reload the page once you are signed in.",
  liveTakeOver: "Take over",
  liveHandBack: "Hand back",
  liveTakeOverHint:
    "Take over the browser to sign in or solve a check. The agent waits meanwhile.",
  liveControlMine: "You control the browser. The agent waits until you hand it back.",
  liveViewOnly:
    "Watching only: this is the user's own agent, so only the user controls its browser.",
  liveControlOther: "You are controlling this browser on another device.",
  liveControlWarning: "Without input the browser goes back to the agent in a minute.",
  liveDialogs:
    "The browser's own windows (file pickers, sign-in dialogs, permissions, open drop-down lists) do not appear here. Use the arrow keys for drop-down lists.",
  liveErrors: {
    LEASE_HELD: "The browser is being controlled on another device.",
    NOT_HOLDER: "You no longer control the browser. Take it over again.",
    VIEW_ONLY: "This view cannot control the browser.",
    STOP_FAILED: "The browser could not be stopped. It keeps running.",
  },
  liveTakeOverHere: "Take over here",
  liveKeyboard: "Keyboard input for the agent browser",
  liveEscape: "Shift+Escape takes you out of the browser back to “Hand back”.",
  liveStart: "Start browser",
  liveStop: "Stop browser",
  liveStopTitle: "Stop the browser?",
  liveStopBody:
    "The agent is using the browser or someone controls it. Stopping closes its tabs now; the agent's next browser call starts it again.",
  liveTab: "Tab",
  liveFollow: "Follow the agent",
  liveNoImage: "No picture yet. It appears once the page changes.",
  livePrivacy: "Only you see this view. AgentPier stores no pictures.",
  livePreview: (name) => `Live view of ${name}'s browser`,
  reset: "Reset browser profile",
  resetDescription:
    "Stops the agent's browser and deletes its profile with every sign-in, cookie and its history.",
  resetConfirm: "Reset profile",
  resetTitle: "Reset the browser profile?",
  resetDone: "The browser profile was deleted.",
  resetFailed: "The browser profile could not be reset.",
};
