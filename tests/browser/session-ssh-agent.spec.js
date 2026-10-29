import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { recordApiRequests } from "../helpers/visibility.js";

// The session SSH dialog shows the session agent's state and aliases from
// GET /sessions/:id/ssh-accesses and follows them on the live job.ssh-tools topic
// (answered here from the REST mock).
async function fixture(page, language = "en", configure = () => {}) {
  const state = {
    session: {
      id: "agent",
      accountId: "local-codex",
      tool: "codex",
      createdAt: "2026-10-29",
      name: "Agent fixture",
      cwd: "/fixture",
      status: "running",
      sshAgent: { enabled: true },
    },
    assignedIds: ["ssh-one"],
    tools: { state: "ready" },
    agent: { state: "ready", aliases: { "ssh-one": "proxmox-2" } },
  };
  configure(state);
  await page.addInitScript(
    (language) => localStorage.setItem("agentpier-language", language),
    language,
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [],
          sessions: [state.session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/ssh-accesses")) {
      if (request.method() === "PUT")
        state.assignedIds = request.postDataJSON().accessIds;
      return route.fulfill({
        json: {
          tools: state.tools,
          agent: state.agent,
          assignedIds: state.assignedIds,
          accesses: [
            {
              id: "ssh-one",
              name: "Proxmox 2",
              host: "proxmox.example.test",
              username: "root",
              port: 22,
            },
            {
              id: "ssh-two",
              name: "Build server",
              host: "build.example.test",
              username: "deploy",
              port: 22,
            },
          ],
          commands: [],
        },
      });
    }
    if (path.endsWith("/chat"))
      return route.fulfill({ json: { availability: "ready", messages: [], tasks: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "status", status: "running" }));
  });
  await page.goto(baseURL + "/sessions/agent/chat");
  return state;
}
const dialog = (page) => page.getByRole("dialog");
const openDialog = (page, name = "SSH accesses") =>
  page.getByRole("button", { name, exact: true }).click();

test("the session dialog shows aliases and the open-connections note in English", async ({
  page,
}) => {
  await fixture(page);
  await openDialog(page);
  await expect(dialog(page).getByText("ssh proxmox-2", { exact: true })).toBeVisible();
  await expect(dialog(page).getByText(/Plain ssh works in this session/)).toBeVisible();
  // Only hosts with an alias get a row.
  await expect(dialog(page).getByText(/^ssh /)).toHaveCount(1);
  await dialog(page).getByText("Learn more", { exact: true }).click();
  await expect(dialog(page).getByText(/stay open until they close/)).toBeVisible();
  await expect(dialog(page).getByText(/helper connections/)).toHaveCount(0);
  await page.screenshot({ path: ".cache/session-ssh-agent-en.png" });
});

test("a new alias arrives live without losing unsaved choices", async ({
  page,
  liveStub,
}) => {
  const state = await fixture(page);
  const requests = recordApiRequests(page);
  await openDialog(page);
  await liveStub.waitForSubscribe("job.ssh-tools:agent");
  await dialog(page)
    .getByRole("checkbox", { name: /Build server/ })
    .check();
  state.agent = {
    state: "ready",
    aliases: { "ssh-one": "proxmox-2", "ssh-two": "build-server" },
  };
  await liveStub.reread("job.ssh-tools:agent");
  await expect(dialog(page).getByText("ssh build-server", { exact: true })).toBeVisible();
  await expect(
    dialog(page).getByRole("checkbox", { name: /Build server/ }),
  ).toBeChecked();
  expect(
    requests.list().filter((request) => request.path.endsWith("/ssh-accesses")),
  ).toHaveLength(1);
});

test.describe("with pushes only from the test", () => {
  test.use({ live: "manual" });

  test("a save answer read before the last push keeps the pushed aliases", async ({
    page,
    liveStub,
  }) => {
    const state = await fixture(page);
    const before = state.agent;
    let release;
    const held = new Promise((resolve) => (release = resolve));
    // The PUT answer was read before the push below: it still names the old aliases.
    await page.route("**/api/sessions/agent/ssh-accesses", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await held;
      await route.fulfill({
        headers: { "X-Read-Started": "1000" },
        json: {
          tools: state.tools,
          agent: before,
          assignedIds: route.request().postDataJSON().accessIds,
          accesses: [
            { id: "ssh-one", name: "Proxmox 2", host: "p", username: "r", port: 22 },
            { id: "ssh-two", name: "Build server", host: "b", username: "d", port: 22 },
          ],
          commands: [],
        },
      });
    });
    await liveStub.waitForSubscribe("state");
    await liveStub.pushRest("state");
    await openDialog(page);
    await liveStub.waitForSubscribe("job.ssh-tools:agent");
    await dialog(page)
      .getByRole("checkbox", { name: /Build server/ })
      .check();
    await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
    liveStub.push(
      "job.ssh-tools:agent",
      {
        tools: state.tools,
        agent: {
          state: "ready",
          aliases: { "ssh-one": "proxmox-2", "ssh-two": "build-server" },
        },
      },
      { readAt: 2000 },
    );
    await expect(
      dialog(page).getByText("ssh build-server", { exact: true }),
    ).toBeVisible();
    release();
    await expect(dialog(page).getByText("Saved", { exact: true })).toBeVisible();
    await expect(
      dialog(page).getByText("ssh build-server", { exact: true }),
    ).toBeVisible();
  });
});

for (const [reason, text] of [
  ["openssh-too-old", /OpenSSH 8\.9 or newer/],
  ["no-openssh", /Plain ssh needs OpenSSH on this computer/],
  ["failed", /could not be started for this session/],
  ["not-eligible", /not available in this session/],
])
  test(`an unavailable agent is explained (${reason})`, async ({ page }) => {
    await fixture(page, "en", (state) => {
      state.agent = { state: "unavailable", reason, aliases: {} };
    });
    await openDialog(page);
    await expect(dialog(page).getByText(text)).toBeVisible();
    await expect(dialog(page).getByText(/^ssh /)).toHaveCount(0);
    await dialog(page).getByText("Learn more", { exact: true }).click();
    await expect(dialog(page).getByText(/helper connections/)).toBeVisible();
  });

test("the German dialog uses the German copy", async ({ page }) => {
  await fixture(page, "de");
  await openDialog(page, "SSH-Zugänge");
  await expect(
    dialog(page).getByText(/Direktes ssh funktioniert in dieser Session/),
  ).toBeVisible();
  await expect(dialog(page).getByText("ssh proxmox-2", { exact: true })).toBeVisible();
});

test("a server without session agents shows no agent line", async ({ page }) => {
  await fixture(page, "en", (state) => {
    delete state.agent;
    delete state.session.sshAgent;
  });
  await openDialog(page);
  await expect(dialog(page).getByText(/SSH tools are ready/)).toBeVisible();
  await expect(dialog(page).getByText(/Plain ssh/)).toHaveCount(0);
});

test("a ~/.ssh/config left unchanged is named with the fallback", async ({ page }) => {
  await fixture(page, "en", (state) => {
    state.agent = { ...state.agent, sshConfig: "SSH_CONFIG_LINK" };
  });
  await openDialog(page);
  await expect(
    dialog(page).getByText(/left ~\/\.ssh\/config unchanged: it is a link\./),
  ).toBeVisible();
  await expect(dialog(page).getByText(/ssh -F "\$AGENTPIER_SSH_CONFIG"/)).toBeVisible();
});

test("a failed ssh check is named in German without its code", async ({ page }) => {
  await fixture(page, "de", (state) => {
    state.agent = { ...state.agent, sshConfig: "SSH_CONFIG_CHECK_FAILED" };
  });
  await openDialog(page, "SSH-Zugänge");
  await expect(
    dialog(page).getByText(/ssh meldete mit dem AgentPier-Block einen Fehler/),
  ).toBeVisible();
  await expect(dialog(page).getByText(/SSH_CONFIG_CHECK/)).toHaveCount(0);
});

test("a session left out of ~/.ssh/config is named as such", async ({ page }) => {
  await fixture(page, "en", (state) => {
    state.agent = { ...state.agent, sshConfig: "SSH_CONFIG_SESSION_LEFT_OUT" };
  });
  await openDialog(page);
  await expect(
    dialog(page).getByText(/outside this session's own ssh does not know its aliases/),
  ).toBeVisible();
  await expect(dialog(page).getByText(/unchanged/)).toHaveCount(0);
});
