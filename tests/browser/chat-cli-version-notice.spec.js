import { test, expect } from "../helpers/browser-test.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

// A running session whose CLI is older than AgentPier supports shows a notice in its
// chat with the way to update it, and the notice goes once the live `state` topic
// reports the installed CLI as current (docs/cli-updates.md#minimum-cli-versions).
const session = {
  id: "outdated-claude",
  name: "Outdated Claude",
  tool: "claude",
  accountId: "local-claude",
  cwd: "/fixture/project",
  status: "running",
  cliVersion: "2.1.300",
};
const claude = (overrides = {}) => ({
  id: "claude",
  name: "Claude",
  installed: true,
  path: "/opt/homebrew/bin/claude",
  version: "2.1.300",
  minimumVersion: "2.1.329",
  versionStatus: "update-required",
  managedInstall: false,
  installMethod: "homebrew",
  updateCommand: "brew upgrade --cask claude-code",
  ...overrides,
});
const workspace = (tool) => ({
  tools: [tool],
  accounts: [{ id: "local-claude", name: "Claude", tool: "claude", kind: "local" }],
  sessions: [session],
  home: "/fixture",
  remoteUrl: null,
});

async function openChat(page, { language, viewport, tool }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    (language) => localStorage.setItem("agentpier-language", language),
    language,
  );
  const state = { value: workspace(tool) };
  const chat = {
    availability: "ready",
    providerSessionId: "native-fixture",
    messages: [{ id: "answer", role: "assistant", text: "Ready for the next task." }],
    tasks: [],
  };
  await mockChatStream(page, () => chat);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state.value });
    if (path.endsWith("/chat")) return route.fulfill({ json: chat });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${baseURL}/sessions/${session.id}/chat`);
  return state;
}

const viewports = [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
];

for (const [device, viewport] of viewports) {
  test(`an external Homebrew CLI below its minimum names brew and goes once updated (${device})`, async ({
    page,
    liveStub,
  }) => {
    const state = await openChat(page, { language: "en", viewport, tool: claude() });
    const notice = page.getByRole("status", { name: "CLI out of date", exact: true });
    await expect(notice).toContainText(
      "This Claude Code 2.1.300 is older than AgentPier supports (2.1.329). Some chat features may not work. Update it:",
    );
    await expect(notice).toContainText("With Homebrew, in a terminal:");
    await expect(notice.locator("code")).toHaveText("brew upgrade --cask claude-code");
    await expect(
      notice.getByRole("button", { name: "Copy command", exact: true }),
    ).toBeVisible();
    await expect(notice).toContainText("Then reload the session to use the new version.");
    // Nothing on the notice may push the page wider than the phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/chat-cli-version-notice-${device}.png`,
      animations: "disabled",
    });
    // `brew upgrade` ran: the next tool detection reads 2.1.329 and the topic pushes it.
    state.value = workspace(claude({ version: "2.1.329", versionStatus: "ok" }));
    liveStub.push("state", state.value);
    await expect(notice).toHaveCount(0);
  });
}

test("a managed CLI offers AgentPier's update dialog, in German on a phone", async ({
  page,
}) => {
  await openChat(page, {
    language: "de",
    viewport: { width: 390, height: 844 },
    tool: claude({
      managedInstall: true,
      installMethod: undefined,
      updateCommand: undefined,
    }),
  });
  const notice = page.getByRole("status", { name: "CLI veraltet", exact: true });
  await expect(notice).toContainText(
    "Dieses Claude Code 2.1.300 ist älter, als AgentPier unterstützt (2.1.329).",
  );
  await expect(notice.locator("code")).toHaveCount(0);
  await notice
    .getByRole("button", { name: "Claude Code aktualisieren", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Claude Code aktualisieren", exact: true }),
  ).toBeVisible();
});

test("an install AgentPier cannot place gets the generic hint; an unknown version none", async ({
  page,
  liveStub,
}) => {
  const state = await openChat(page, {
    language: "en",
    viewport: { width: 1280, height: 800 },
    tool: claude({ installMethod: "unknown", updateCommand: undefined }),
  });
  const notice = page.getByRole("status", { name: "CLI out of date", exact: true });
  await expect(notice).toContainText(
    "With the package manager, installer or download you installed it with.",
  );
  await expect(notice.locator("code")).toHaveCount(0);
  // A session whose CLI version could not be read never shows it.
  state.value = {
    ...workspace(claude()),
    sessions: [{ ...session, cliVersion: undefined }],
  };
  liveStub.push("state", state.value);
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Ready for the next task.")).toBeVisible();
});
