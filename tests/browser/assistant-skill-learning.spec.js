import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../helpers/browser-test.js";
import { fixture } from "./providers-fixture.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

// "Learns its own skills" in the Capabilities tab (ADR 0007, step 6): the server
// sends the effective value, whether the switch is locked and the runtime's traits.
const home = {
  id: "home",
  name: "Home",
  instructions: "",
  revision: 1,
  effectiveRevision: 1,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: true, reminders: false },
  // The built-in runtime's default: an agent that never chose does not learn.
  skillLearning: false,
};
// The view of a runtime whose agents learn unless switched off.
const perAgent = {
  id: "second",
  name: "Second Runtime",
  version: null,
  capabilities: {
    skills: {
      available: true,
      learnsByDefault: true,
      userAgentsLearn: true,
      writesWhenAsked: true,
    },
  },
};
// AGENTPIER_SCREENSHOT_DIR keeps the switch's screenshots for a review; without it
// they are attached to the test's output only.
const shots = process.env.AGENTPIER_SCREENSHOT_DIR;

// A stand-in for the server that keeps the switch a PATCH stores on the profile.
async function setup(page, { language = "en", agent = {} } = {}) {
  await fixture(page);
  await page.addInitScript(
    (value) => localStorage.setItem("agentpier-language", value),
    language,
  );
  const state = { agent: { ...home, ...agent }, patches: [] };
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/assistant-events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"connected"}\n\n',
      });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      state.patches.push(body);
      state.agent = { ...state.agent, ...body, revision: state.agent.revision + 1 };
      return route.fulfill({ json: { ...state.agent, pending: false } });
    }
    if (pathname === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [state.agent],
          conversations: [],
          models: [{ id: "router", name: "Router", available: true }],
        },
      });
    if (pathname === "/api/assistant-runtime")
      return route.fulfill({
        json: { availability: "ready", sync: "current", browser: { available: true } },
      });
    return route.fulfill({ json: {} });
  });
  return state;
}
const skills = (page, name = "Skills") =>
  page.locator("#agent-skills", { hasText: name });
async function shot(page, testInfo, name) {
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const file = shots ? path.join(shots, name) : testInfo.outputPath(name);
  await skills(page).screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

test("the owner switches learning on and saves it with the tab", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  await page.goto(settingsPath("capabilities"));
  const learning = page.getByRole("switch", {
    name: "Learns its own skills",
    exact: true,
  });
  // Off by default on the built-in runtime.
  await expect(learning).not.toBeChecked();
  await expect(learning).toBeEnabled();
  await expect(skills(page)).toContainText(
    "reviews finished work in the background and saves reusable procedures as its own skills",
  );
  await expect(skills(page)).toContainText("additional model calls on the agent's model");
  await expect(skills(page)).toContainText("other chats and its memory");
  // What "off" means here: no skill of its own at all.
  await expect(skills(page)).toContainText(
    "While this is off, the agent cannot save skills of its own.",
  );
  await learning.click();
  await expect(learning).toBeChecked();
  await shot(page, testInfo, "runtime-learning-switch-en.png");
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ skillLearning: true, revision: 1 });
  await expect(saveBar(page)).toBeHidden();
  await expect(learning).toBeChecked();
  await learning.click();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(2);
  expect(state.patches[1]).toEqual({ skillLearning: false, revision: 2 });
});

test("an agent of a runtime that learns by default starts switched on", async ({
  page,
}) => {
  const state = await setup(page, {
    agent: { runtime: "second", runtimeInfo: perAgent, skillLearning: true },
  });
  await page.goto(settingsPath("capabilities"));
  const learning = page.getByRole("switch", {
    name: "Learns its own skills",
    exact: true,
  });
  await expect(learning).toBeChecked();
  await expect(skills(page)).toContainText(
    "While this is off, the agent still writes a skill when you ask it to.",
  );
  await learning.click();
  await saveBar(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ skillLearning: false, revision: 1 });
});

test("a user's agent shows the switch locked with the reason", async ({ page }) => {
  const state = await setup(page, {
    agent: {
      userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }] },
      ownerReads: true,
      skillLearningLocked: true,
      runtimeInfo: { id: "openclaw", name: "OpenClaw", capabilities: {} },
    },
  });
  await page.goto(settingsPath("capabilities"));
  const learning = page.getByRole("switch", {
    name: "Learns its own skills",
    exact: true,
  });
  await expect(learning).toBeDisabled();
  await expect(learning).not.toBeChecked();
  await expect(skills(page)).toContainText(
    "Locked for agents of users on OpenClaw: learned skills would bypass the skill list that limits what they read.",
  );
  expect(state.patches).toEqual([]);
});

test("a user's agent on a runtime that lets it learn has a working switch", async ({
  page,
}) => {
  await setup(page, {
    agent: {
      userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }] },
      ownerReads: true,
      runtime: "second",
      runtimeInfo: perAgent,
      skillLearning: true,
    },
  });
  await page.goto(settingsPath("capabilities"));
  const learning = page.getByRole("switch", {
    name: "Learns its own skills",
    exact: true,
  });
  await expect(learning).toBeEnabled();
  await expect(learning).toBeChecked();
});

test("the learning switch in German", async ({ page }, testInfo) => {
  await setup(page, { language: "de", agent: { skillLearning: true } });
  await page.goto(settingsPath("capabilities"));
  const learning = page.getByRole("switch", { name: "Lernt eigene Skills", exact: true });
  await expect(learning).toBeChecked();
  await expect(learning).toBeEnabled();
  await expect(skills(page)).toContainText(
    "wertet erledigte Arbeit im Hintergrund aus und speichert wiederverwendbare Abläufe als eigene Skills",
  );
  await expect(skills(page)).toContainText("zusätzliche Modellaufrufe");
  await expect(skills(page)).toContainText(
    "Ausgeschaltet kann der Agent keine eigenen Skills speichern.",
  );
  await shot(page, testInfo, "runtime-learning-switch-de.png");
});

test("a task member has no switch of its own", async ({ page }) => {
  await setup(page, {
    agent: {
      teamMemberId: "home",
      parentAssistantId: "lead",
      lifetime: "temporary",
      capabilities: {},
      inherited: { capabilities: {} },
    },
  });
  await page.goto(settingsPath("capabilities"));
  await expect(
    page.getByRole("tab", { name: "Capabilities", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("switch", { name: "Learns its own skills" })).toHaveCount(
    0,
  );
});
