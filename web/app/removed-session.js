// Where the app goes after a session is removed (AGENTPIER-415): only a removed session
// that fills the screen leaves for the start page. Removing one from a split view's
// pane menu, the sidebar or another page keeps the page that is on screen.

/** Whether removing `sessionId` while `route` shows leaves for the start page. */
export const leavesAfterRemoval = (route, sessionId) =>
  route?.view === "workspace" && route.sessionId === sessionId;
