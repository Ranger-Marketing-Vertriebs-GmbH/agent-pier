import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";

// The server acknowledges a message only once the agent service took it, which may
// take seconds: the message leaves the field and shows in the chat at once, and a
// refused one comes back into the field.
const timestamp = Date.now();

async function setup(page) {
  await fixture(page);
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const assistant = {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
  };
  const state = {
    messages: [{ id: "first", role: "user", text: "Hello", timestamp }],
    requests: [],
    posted: [],
    answer: null,
  };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: [assistant],
        conversations: [{ id: "dinner", assistantId: "home" }],
        models: [{ id: "router", name: "OpenRouter", available: true }],
        members: [],
        activity: {},
      };
    else if (p === "/api/assistant-runtime")
      body = { availability: "ready", sync: "current" };
    else if (p.endsWith("/messages") && route.request().method() === "POST") {
      state.posted.push(route.request().postDataJSON());
      // Held until the test lets the agent service answer.
      const answer = await new Promise((resolve) => (state.answer = resolve));
      return route.fulfill(answer);
    } else if (p.endsWith("/messages"))
      body = { messages: state.messages, requests: state.requests, stale: false };
    else if (p === "/api/assistants/home") body = assistant;
    await route.fulfill({ json: body });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  return state;
}

test("a sent message leaves the field and shows before the server answers", async ({
  page,
}) => {
  const state = await setup(page);
  const field = page.getByRole("textbox", { name: "Message" });
  await field.fill("What is for dinner?");
  await field.press("Enter");
  await expect.poll(() => state.posted.length).toBe(1);
  await expect(field).toHaveValue("");
  await expect(page.locator(".assistant-message")).toHaveCount(2);
  await expect(page.locator(".assistant-message").last()).toContainText(
    "What is for dinner?",
  );
  // Nothing to send again, and no Stop button yet to hit by accident.
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  const createdAt = new Date().toISOString();
  const request = {
    id: "request-1",
    clientRequestId: state.posted[0].clientRequestId,
    text: "What is for dinner?",
    state: "running",
    createdAt,
    attempt: { id: "attempt-1", state: "running", reviewedAt: null, createdAt },
  };
  state.requests = [request];
  state.answer({ json: { request, attempt: request.attempt } });
  // Accepted: the turn's own message takes over, once.
  await expect(page.getByRole("button", { name: "Stop" }).first()).toBeVisible();
  await expect(page.locator(".assistant-message")).toHaveCount(2);
  await expect(field).toHaveValue("");
});

test("a refused message comes back into the field with the same delivery key", async ({
  page,
}) => {
  const state = await setup(page);
  const field = page.getByRole("textbox", { name: "Message" });
  await field.fill("What is for dinner?");
  await field.press("Enter");
  await expect.poll(() => state.posted.length).toBe(1);
  await expect(field).toHaveValue("");
  state.answer({ status: 503, json: { error: "The agent service is not ready." } });
  await expect(field).toHaveValue("What is for dinner?");
  await expect(page.locator(".assistant-message")).toHaveCount(1);
  await expect(page.getByText("The agent service is not ready.")).toBeVisible();
  // A retry is the same delivery, so the server never sends it twice.
  await field.press("Enter");
  await expect.poll(() => state.posted.length).toBe(2);
  expect(state.posted[1].clientRequestId).toBe(state.posted[0].clientRequestId);
  state.answer({ status: 503, json: { error: "The agent service is not ready." } });
});
