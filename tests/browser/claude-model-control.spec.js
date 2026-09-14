import fs from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { ModelController } from "../../server/features/models/model-controller.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

for (const language of ["de", "en"]) {
  test(`mobile Claude chat switches a wrapped native picker and preserves the draft (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (language) => localStorage.setItem("agentpier-language", language),
      language,
    );
    const session = {
      id: "claude-model",
      name: "Claude models",
      tool: "claude",
      accountId: "local-claude",
      cwd: "/fixture/project",
      status: "running",
    };
    const menu = await fs.readFile(
      new URL("../fixtures/models/claude-model-50.txt", import.meta.url),
      "utf8",
    );
    let current = "Sonnet 4.6";
    const idle = () =>
      `Claude Code\n${current} · API Usage Billing\n❯ native draft\n? for shortcuts`;
    let screen = idle();
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
              else if (input.join() === "Up")
                screen = menu
                  .replace("    5. Haiku", "  ❯ 5. Haiku")
                  .replace("  ❯ 6.", "    6.");
              else if (input.join() === "s") {
                current = "Haiku 4.5";
                screen = idle();
              } else if (input.join() === "Escape") screen = idle();
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
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let result = {};
      if (path === "/api/state")
        result = {
          tools: [{ id: "claude", name: "Claude", installed: true }],
          accounts: [
            { id: "local-claude", name: "Claude", tool: "claude", kind: "local" },
          ],
          sessions: [session],
          home: "/fixture",
          remoteUrl: null,
        };
      else if (path.endsWith("/chat")) result = chat;
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
    const draft = page.getByRole("textbox", {
      name: language === "en" ? "Message" : "Nachricht",
      exact: true,
    });
    await draft.fill("Keep my draft");
    const trigger = page.getByRole("button", {
      name: language === "en" ? "Choose model" : "Modell auswählen",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: language === "en" ? "Model selection" : "Modellauswahl",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "Haiku", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Newer version available · select Sonnet for Sonnet 5", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: language === "en" ? "Send" : "Senden",
        exact: true,
      }),
    ).toBeDisabled();
    await page.screenshot({
      path: `test-results/claude-model-mobile-${language}.png`,
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Haiku", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toContainText("Haiku 4.5");
    await expect(draft).toHaveValue("Keep my draft");
    await expect(page).toHaveURL(/\/chat$/);
    expect(keys).toEqual([["M-p"], ["Up"], ["s"]]);
    await trigger.click();
    await dialog
      .getByRole("button", {
        name: language === "en" ? "Cancel selection" : "Auswahl abbrechen",
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(draft).toHaveValue("Keep my draft");
    expect(keys.at(-1)).toEqual(["Escape"]);
  });
}
