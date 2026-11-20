import { expect } from "./browser-test.js";
import { fulfillEnabledAssistantFeature } from "./assistant-browser-fixture.js";
import { fixture } from "../browser/providers-fixture.js";

// The owner's live view of the agent "home"'s browser (AgentBrowserView.jsx) against a
// stubbed browser stream: agent-browser-live.spec.js and agent-browser-toolbar.spec.js.
export const home = {
  id: "home",
  name: "Home",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { browser: true },
  browserRunning: true,
};
// A real 1x1 JPEG, so a test sees whether the browser may decode the picture.
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////" +
    "////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAA" +
    "AAAAAP/aAAgBAQABPxA=",
  "base64",
);
// One frame as OpenClaw sends it: header length, JSON header, JPEG bytes.
export function frame() {
  const header = Buffer.from(
    JSON.stringify({ url: "https://shop.example/", cssWidth: 800 }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, jpeg]);
}
// The picture loaded and decoded (the page's CSP allows blob: images).
export const decoded = (picture) =>
  expect
    .poll(() => picture.evaluate((img) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
export const tabs = [
  { targetId: "t1", title: "Shop", url: "https://shop.example/" },
  { targetId: "t2", title: "Cart", url: "https://shop.example/cart" },
];

/**
 * Stubs the app and the browser stream; returns every command the page sent. The
 * stub answers like the server: take and hand back, stop, and the takeover
 * toolbar's navigation and tab commands, which change the pushed address and tabs.
 */
export async function setup(
  page,
  {
    status = "live",
    refuse = false,
    control,
    viewOnly = false,
    busy = false,
    stopFails = false,
    agent = {},
  } = {},
) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [{ ...home, ...agent }],
          conversations: [
            {
              id: "c1",
              assistantId: "home",
              runtimeSessionKey: "k",
              channel: "agentpier",
            },
          ],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (path === "/api/assistant-runtime")
      return route.fulfill({
        json: {
          availability: "ready",
          sync: "current",
          browser: {
            available: true,
            name: "Chrome for Testing",
            visible: { available: true },
          },
        },
      });
    if (path.endsWith("/messages"))
      return route.fulfill({ json: { messages: [], requests: [] } });
    return route.fulfill({ json: {} });
  });
  const commands = [];
  commands.connects = 0;
  await page.routeWebSocket("**/api/assistants/home/browser-stream*", (ws) => {
    commands.connects++;
    let current = status;
    let held = control || { held: false, mine: false };
    // The browser as the stub server sees it: its tabs and each tab's history.
    const shown = { targetId: "t1", tabs: tabs.map((tab) => ({ ...tab })) };
    const history = { t1: ["https://shop.example/"], t2: ["https://shop.example/cart"] };
    const tab = () => shown.tabs.find((one) => one.targetId === shown.targetId);
    const state = (next = held) => {
      held = next;
      ws.send(
        JSON.stringify({
          type: "state",
          state: {
            status: current,
            url: tab()?.url || "",
            title: tab()?.title || "",
            targetId: shown.targetId,
            tabs: shown.tabs,
            control: held,
            busy,
            // A view-only viewer sees a pinned tab but cannot follow the agent.
            ...(viewOnly ? { viewOnly, pinned: true } : {}),
          },
        }),
      );
    };
    const visit = (url) => {
      history[shown.targetId].push(url);
      Object.assign(tab(), { url, title: new URL(url).hostname });
    };
    ws.onMessage((message) => {
      const command = JSON.parse(message);
      commands.push(command);
      // The server's answer to a takeover and a hand-back.
      if (command.type === "take") state({ held: true, mine: true, warning: false });
      if (command.type === "handBack") state({ held: false, mine: false });
      // The server stops the browser; the next refresh reports it stopped.
      if (command.type === "stop" && stopFails)
        ws.send(JSON.stringify({ type: "error", code: "STOP_FAILED" }));
      else if (command.type === "stop") {
        current = "stopped";
        state({ held: false, mine: false });
      }
      // The toolbar: the stream then pushes the new address or tabs.
      if (command.type === "navigate" && command.action === "go") {
        if (/127\.0\.0\.1|localhost/.test(command.url))
          return ws.send(JSON.stringify({ type: "error", code: "NAVIGATION_BLOCKED" }));
        visit(/^https?:/.test(command.url) ? command.url : `https://${command.url}/`);
        state();
      }
      if (command.type === "navigate" && command.action === "back") {
        const visited = history[shown.targetId];
        if (visited.length > 1) visited.pop();
        Object.assign(tab(), { url: visited.at(-1) });
        state();
      }
      if (command.type === "tab" && command.action === "switch") {
        shown.targetId = command.targetId;
        state();
      }
      if (command.type === "tab" && command.action === "close") {
        shown.tabs = shown.tabs.filter((one) => one.targetId !== command.targetId);
        shown.targetId = shown.tabs[0]?.targetId ?? null;
        state();
      }
    });
    state();
    if (status === "live") ws.send(frame());
    if (refuse) ws.close({ code: 1008 });
  });
  return commands;
}
