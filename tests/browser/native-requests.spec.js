import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";
const request = {
  id: "request-one",
  sessionId: "fixture-session",
  kind: "question",
  revision: 1,
  status: "pending",
  source: "codex",
  createdAt: "2026-09-07T12:00:00Z",
  questions: [
    {
      id: "question-one",
      prompt: "Choose a scope",
      options: [
        { id: "tests", label: "Tests", description: "Run the test suite" },
        { id: "docs", label: "Docs" },
      ],
      multiple: true,
      allowOther: true,
    },
    {
      id: "question-two",
      prompt: "Choose a target",
      options: [{ id: "local", label: "Local" }],
      multiple: false,
      allowOther: true,
    },
  ],
};
test("native questions require all answers and retain drafts on conflict without sending ordinary chat", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.requests = [request];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await expect(page.getByText("Choose a scope", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Modell auswählen", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  expect(state.calls.some((call) => call.path.endsWith("/answer"))).toBe(false);
  await page.getByLabel("Tests", { exact: true }).check();
  await page.getByLabel("Docs", { exact: true }).check();
  await page.getByLabel("Local", { exact: true }).check();
  state.fail = "/sessions/fixture-session/requests/request-one/answer";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture conflict");
  await expect(page.getByLabel("Tests", { exact: true })).toBeChecked();
  state.fail = "";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(page.getByText("Choose a scope", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeEnabled();
  expect(state.calls.filter((call) => call.path.endsWith("/answer")).at(-1).body).toEqual(
    {
      expectedRevision: 1,
      answers: { "question-one": ["tests", "docs"], "question-two": ["local"] },
    },
  );
  expect(
    state.calls.some((call) => call.method === "POST" && call.path.endsWith("/chat")),
  ).toBe(false);
});
test("mobile permission request preserves native options and unknown outcomes offer only Terminal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await operationsFixture(page);
  state.requests = [
    {
      ...request,
      kind: "permission",
      questions: undefined,
      subject: { command: "command ".repeat(80), cwd: "/fixture/project" },
      options: [
        { id: "once", label: "Allow once", scope: "once" },
        { id: "deny", label: "Deny" },
      ],
    },
  ];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(
    0,
  );
  expect(state.calls.find((call) => call.path.endsWith("/answer")).body).toEqual({
    expectedRevision: 1,
    choice: "once",
  });
  state.requests = [{ ...request, status: "unknown" }];
  await page.reload();
  await expect(
    page.getByText("Zustellung unklar. Im Terminal prüfen.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Antwort senden", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
test("secret native answers stay masked and a new occurrence resets the draft", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  const secretQuestion = {
    id: "q0",
    prompt: "Fixture access phrase",
    options: [],
    multiple: false,
    allowOther: true,
    secret: true,
  };
  state.requests = [{ ...request, questions: [secretQuestion] }];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  const input = page.locator('input[type="password"]');
  await input.fill("fixture secret");
  expect(await input.getAttribute("autocomplete")).toBe("off");
  state.requests = [{ ...request, id: "request-two", questions: [secretQuestion] }];
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(
    "fixture secret",
  );
  await input.fill("replacement fixture");
  state.hold = "/sessions/fixture-session/requests/request-two/answer";
  await page.getByRole("button", { name: "Antwort senden", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Antwort senden", exact: true }),
  ).toBeDisabled();
  expect(state.calls.filter((call) => call.path.endsWith("/answer"))).toHaveLength(1);
  state.release();
  await expect(input).toHaveCount(0);
  expect(state.calls.find((call) => call.path.endsWith("/answer")).body.answers).toEqual({
    q0: ["replacement fixture"],
  });
});
test("short mobile native request controls stay inside the workspace and remain actionable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const state = await operationsFixture(page);
  state.requests = [
    {
      ...request,
      kind: "permission",
      questions: undefined,
      subject: { command: "fixture command ".repeat(80) },
      options: [{ id: "allow", label: "Allow once" }],
    },
  ];
  await page.goto(baseURL + "/sessions/fixture-session/chat");
  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();
  const area = await page.locator(".chat-compose-area").boundingBox();
  const workspace = await page.locator(".chat-main").boundingBox();
  expect(area.y + area.height).toBeLessThanOrEqual(workspace.y + workspace.height);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Nachricht", exact: true }),
  ).toBeEnabled();
});
