import fs from "node:fs/promises";
import { test, expect } from "../helpers/browser-test.js";
import { ModelController } from "../../server/features/models/model-controller.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

// A file dropped on the chat while the native model picker is open attaches like
// any other drop: the open picker holds sending, not the draft's attachments.
const directory = "/tmp/agentpier-test-attachments/local-claude/drop-model";

async function fixture(page, language) {
  await page.addInitScript(
    (language) => localStorage.setItem("agentpier-language", language),
    language,
  );
  const session = {
    id: "drop-model",
    name: "Drop with model picker",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/fixture/project",
    status: "running",
    attachments: { directory },
  };
  const menu = await fs.readFile(
    new URL("../fixtures/models/claude-2.1.329-model.ansi", import.meta.url),
    "utf8",
  );
  const idle =
    "Claude Code\nOpus 5.5 · API Usage Billing\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)";
  let screen = idle;
  const keys = [];
  // Only the external CLI is doubled; the real parser, controller and chat UI run.
  const models = new ModelController({
    sessions: {
      control: async (id, operation) =>
        operation({
          session,
          screen: async () => screen,
          keys: async (input) => {
            keys.push(input);
            if (input.join() === "M-p") screen = menu;
            else if (input.join() === "Escape") screen = idle;
            else throw new Error("Unexpected native control input");
          },
        }),
    },
  });
  const chat = {
    availability: "ready",
    providerSessionId: "native-fixture",
    messages: [{ id: "answer", role: "assistant", text: "Ready for the next task." }],
    tasks: [],
  };
  await mockChatStream(page, () => chat);
  const uploads = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result = {};
    if (path === "/api/state")
      result = {
        tools: [{ id: "claude", name: "Claude", installed: true }],
        accounts: [{ id: "local-claude", name: "Claude", tool: "claude", kind: "local" }],
        sessions: [session],
        home: "/fixture",
        remoteUrl: null,
      };
    else if (path.endsWith("/chat/attachments")) {
      const body = route.request().postDataJSON();
      uploads.push(body.name);
      result = { name: body.name, path: `${directory}/${body.name}` };
    } else if (path.endsWith("/chat")) result = chat;
    else if (path.endsWith("/models")) result = await models.read(session.id);
    else if (/\/models\/(open|select|cancel)$/.test(path)) {
      try {
        result = await models[path.split("/").at(-1)](
          session.id,
          route.request().postDataJSON(),
        );
      } catch (error) {
        return route.fulfill({
          status: error.status || 500,
          json: { error: error.message },
        });
      }
    }
    await route.fulfill({ json: result });
  });
  await page.goto(`${baseURL}/sessions/${session.id}/chat`);
  return { keys, uploads };
}

for (const language of ["en", "de"]) {
  test(`a screenshot dropped while the model picker is open is attached (${language})`, async ({
    page,
  }) => {
    const state = await fixture(page, language);
    await page
      .getByRole("button", {
        name: language === "en" ? "Choose model" : "Modell auswählen",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: language === "en" ? "Model selection" : "Modellauswahl",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "Haiku", exact: true }),
    ).toBeVisible();
    const transfer = await page.evaluateHandle(() => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", {
          type: "image/png",
        }),
      );
      return carrier;
    });
    // Over the picker itself, the drop zone still arms and takes the file.
    const panel = page.locator(".chat-main");
    await dialog.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(panel).toHaveAttribute("data-dropping", "true");
    await dialog.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(
      page.getByRole("listitem").filter({ hasText: "screenshot.png" }),
    ).toBeVisible();
    expect(state.uploads).toEqual(["screenshot.png"]);
    await expect(panel).not.toHaveAttribute("data-dropping", "true");
    // Sending still waits for the picker; the drop sent nothing to the terminal.
    await expect(
      page.getByRole("button", {
        name: language === "en" ? "Send" : "Senden",
        exact: true,
      }),
    ).toBeDisabled();
    expect(state.keys).toEqual([["M-p"]]);
  });
}
