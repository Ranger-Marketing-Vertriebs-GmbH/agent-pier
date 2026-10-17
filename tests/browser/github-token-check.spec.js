import { test, expect } from "@playwright/test";

import { baseURL as base } from "../helpers/browser.js";
import { fixture } from "../helpers/repository-browser.js";

const checkedAt = "2026-10-17T10:00:00Z";

test("Check shows what GitHub reports about a token and keeps the token private", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const { repositories } = await fixture(page);
  repositories.credentials.push({
    id: "expired",
    name: "Old",
    host: "https://github.com",
    hasSecret: true,
    agentDefault: false,
    createdAt: checkedAt,
    tokenCheck: {
      state: "expired",
      error: "unauthorized",
      tokenType: "classic",
      scopes: null,
      expiresAt: "2026-10-01T00:00:00Z",
      checkedAt,
    },
  });
  const checks = [];
  let answer = {
    state: "valid",
    login: "octo",
    tokenType: "classic",
    scopes: ["repo", "read:org"],
    expiresAt: "2026-12-24T12:00:00Z",
    sso: [
      {
        organization: "acme",
        url: "https://github.com/orgs/acme/sso?authorization_request=fixture",
      },
    ],
    checkedAt,
  };
  await page.route("**/api/git-credentials/*/check", async (route) => {
    const id = route.request().url().split("/").at(-2);
    checks.push({ id, method: route.request().method() });
    const credential = repositories.credentials.find((item) => item.id === id);
    if (!answer) return route.fulfill({ status: 409, json: { error: "Changed." } });
    credential.tokenCheck = answer;
    await route.fulfill({ json: credential });
  });
  await page.goto(base + "/settings/github");
  const row = (name) =>
    page
      .locator('[role="row"]')
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(row("Persönlich")).toContainText("Not checked yet");
  await expect(row("Old")).toContainText("Token expired");
  await expect(row("Old")).toContainText("GitHub rejected the token. Save a new token.");
  await page.getByRole("button", { name: "Check token of Persönlich" }).click();
  await expect(row("Persönlich")).toContainText("Token valid");
  await expect(row("Persönlich")).toContainText("Signed in as octo");
  await expect(row("Persönlich")).toContainText("Classic token");
  await expect(row("Persönlich")).toContainText("Scopes: repo, read:org");
  await expect(row("Persönlich")).toContainText("Expires");
  await expect(row("Persönlich")).toContainText(
    "Organization acme requires SAML SSO authorization for this token.",
  );
  await expect(
    row("Persönlich").getByRole("link", { name: "Authorize on GitHub" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/orgs/acme/sso?authorization_request=fixture",
  );
  expect(checks).toEqual([{ id: "personal", method: "POST" }]);
  // A failed request keeps the last result and names the error.
  answer = null;
  await page.getByRole("button", { name: "Check token of Old" }).click();
  await expect(row("Old")).toContainText("Changed.");
  await expect(row("Old")).toContainText("Token expired");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("a session footer names its GitHub profile and warns about SSH remotes", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  const { state } = await fixture(page);
  state.sessions.push({
    id: "ssh-session",
    name: "SSH fixture",
    tool: "shell",
    cwd: "/home/test/project",
    status: "running",
    accountId: "local-shell",
    createdAt: checkedAt,
  });
  state.github = {
    configured: true,
    hosts: [
      {
        host: "github.com",
        credentialId: "personal",
        name: "Persönlich",
        tokenState: "expired",
      },
    ],
    remote: { protocol: "ssh", host: "github.com" },
  };
  await page.goto(base + "/sessions/ssh-session/terminal");
  const footer = page.locator(".session-footer");
  await expect(footer).toContainText("Persönlich (github.com)");
  await expect(footer).toContainText(
    "github.com: token needs attention in Settings → Access → GitHub connections",
  );
  await expect(footer).toContainText(
    "The project remote uses SSH. GitHub tokens apply to HTTPS only",
  );
});
