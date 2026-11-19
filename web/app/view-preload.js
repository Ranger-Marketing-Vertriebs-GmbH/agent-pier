import { useEffect } from "react";
// Loads the code of the views the owner is likely to open while AgentPier cannot be
// reached, once the app has started online. Lazily loaded views fetch their chunk on
// first use, and without a connection that fetch fails and the page shows "View
// unavailable". A module imported once stays in the page's module map until the page
// reloads, so these views render their shells and offline notices afterwards
// (docs/mobile-recovery.md, "Views opened offline").
//
// The loaders name the same modules as the lazy() calls that render them, so the
// build maps both to the same chunks (and their CSS). A new build changes every chunk
// name; this page keeps the build it started with until it reloads.

// One agent's chat, "Manage all agents" and the agent settings (AgentsPage), and the
// chat a split view shows.
const AGENT_VIEWS = [
  () => import("../features/assistants/AgentsPage.jsx"),
  () => import("../features/assistants/AssistantChat.jsx"),
];
// A session: its workspace with the terminal, the chat (reader), the previews button
// and the changes tab; split views; and the tool output and diffs chats render.
const WORKSPACE_VIEWS = [
  () => import("../features/sessions/SessionWorkspace.jsx"),
  () => import("../features/terminal/TerminalView.jsx"),
  () => import("../features/previews/SessionPreviews.jsx"),
  () => import("../features/sessions/SessionChanges.jsx"),
  () => import("../features/views/SplitViewPage.jsx"),
  () => import("../features/chat/ToolCode.jsx"),
  () => import("../components/diff/DiffRows.jsx"),
];

// The views to load: the agent views only while agents are on.
export function preloadLoaders({ agents }) {
  return agents ? [...WORKSPACE_VIEWS, ...AGENT_VIEWS] : WORKSPACE_VIEWS;
}

// Whether the owner asked the browser to save data (Data Saver, Low Data Mode).
export function savesData(navigatorLike = globalThis.navigator) {
  return navigatorLike?.connection?.saveData === true;
}

function idle(callback) {
  if (typeof globalThis.requestIdleCallback === "function")
    globalThis.requestIdleCallback(callback, { timeout: 5000 });
  else globalThis.setTimeout(callback, 1500);
}

function mark(state) {
  const root = globalThis.document?.documentElement;
  if (root) root.dataset.viewPreload = state;
}

// Imports each loader in turn, one per idle period, so the first render and the
// owner's input come first. A loader that fails (the connection dropped, the server
// restarts) is tried again on the next `online` event. The page's root element
// carries the progress in data-view-preload, which the browser tests wait for:
// "loading", "done", "incomplete" (some wait for the connection) or "skipped" (data
// saver).
export function preloadViews(
  loaders,
  { schedule = idle, saveData = savesData(), target = globalThis.window } = {},
) {
  if (saveData) {
    mark("skipped");
    return Promise.resolve([]);
  }
  mark("loading");
  const step = (loader) =>
    new Promise((resolve) =>
      schedule(() =>
        loader().then(
          () => resolve(null),
          () => resolve(loader),
        ),
      ),
    );
  const run = async (pending) => {
    const failed = [];
    for (const loader of pending) {
      const left = await step(loader);
      if (left) failed.push(left);
    }
    return failed;
  };
  return run(loaders).then((failed) => {
    if (!failed.length || !target?.addEventListener) {
      mark(failed.length ? "incomplete" : "done");
      return failed;
    }
    mark("incomplete");
    target.addEventListener("online", () => preloadViews(failed, { schedule, target }), {
      once: true,
    });
    return failed;
  });
}

let started = false;
// Starts the preload once per page load, after the workspace state arrived and the
// agent feature is known.
export function useViewPreload({ ready, agentsLoading, agentsEnabled }) {
  useEffect(() => {
    if (started || !ready || agentsLoading) return;
    started = true;
    void preloadViews(preloadLoaders({ agents: agentsEnabled }));
  }, [ready, agentsLoading, agentsEnabled]);
}
