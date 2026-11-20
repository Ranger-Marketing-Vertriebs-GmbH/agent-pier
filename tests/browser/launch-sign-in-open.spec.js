import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { openNewSession } from "../helpers/navigation.js";
import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";

// A session start refused while the account's sign-in session is open
// (AGENTPIER-394): the refusal names that session and the dialog offers to stop it.
test.use({ locale: "en-GB" });

test("a start blocked by the open sign-in names it and stops it on request", async ({
  page,
}) => {
  const state = {
    tools: [
      {
        id: "opencode",
        name: "OpenCode",
        installed: true,
        path: "/bin/opencode",
        version: "1.18.35",
        minimumVersion: "1.18.29",
        versionStatus: "ok",
      },
    ],
    utilities: [],
    accounts: [
      {
        id: "local-opencode",
        tool: "opencode",
        name: "OpenCode",
        kind: "local",
        hasSecret: false,
        createdAt: null,
      },
    ],
    sessions: [],
    home: "/home/test",
    remoteUrl: null,
  };
  const calls = { launches: 0, stopped: [] };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/sessions" && request.method() === "POST") {
      calls.launches++;
      return route.fulfill({
        status: 409,
        json: {
          code: "SESSION_LOGIN_OPEN",
          sessionId: "login-1",
          error:
            "Die Anmelde-Session „OpenCode · Anmeldung“ dieses Accounts ist noch offen. Schließe die Anmeldung ab oder beende die Session, bevor du eine Session startest.",
          messageKey: "sessions.loginSessionOpen",
          messageArgs: ["OpenCode · Sign-in"],
        },
      });
    }
    if (path === "/api/sessions/login-1/stop" && request.method() === "POST") {
      calls.stopped.push("login-1");
      return route.fulfill({ json: {} });
    }
    if (path === "/api/ssh-accesses") return route.fulfill({ json: { accesses: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(base);
  await openNewSession(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    'The sign-in session "OpenCode · Sign-in" of this account is still open. Finish or stop it before starting a session.',
  );
  await dialog.getByRole("button", { name: "Stop the sign-in session" }).click();
  await expect.poll(() => calls.stopped).toEqual(["login-1"]);
  await expect(
    dialog.getByRole("button", { name: "Stop the sign-in session" }),
  ).toHaveCount(0);
});
