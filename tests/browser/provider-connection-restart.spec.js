import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const connection = {
  id: "agent-router",
  name: "Agent router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
  createdAt: "2026-09-07T12:00:00Z",
  updatedAt: "2026-09-07T12:00:00Z",
};
const requests = (controls, method) =>
  controls.calls.filter(
    (call) =>
      call.method === method &&
      call.path === `/api/provider-connections/${connection.id}`,
  );

test("changing a connection agents use asks to restart their Gateway first", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [connection];
  controls.assistantConnections.add(connection.id);
  await page.goto(baseURL + "/accounts");

  await page.getByRole("button", { name: "Edit Agent router", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("Agent router 2");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Agents use this connection. Applying the change restarts their Gateway",
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(requests(controls, "PATCH")).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Save and restart agents", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(requests(controls, "PATCH").at(-1).body).toEqual({
    name: "Agent router 2",
    confirmRestart: true,
  });

  await page.getByRole("button", { name: "Delete Agent router 2", exact: true }).click();
  const removal = page.getByRole("dialog");
  await removal.getByRole("button", { name: "Delete connection", exact: true }).click();
  await expect(removal.getByRole("status")).toContainText("restarts their Gateway");
  await removal
    .getByRole("button", { name: "Delete and restart agents", exact: true })
    .click();
  await expect(removal).toHaveCount(0);
  expect(requests(controls, "DELETE").at(-1).body).toEqual({ confirmRestart: true });
  await expect(page.getByText("Agent router 2")).toHaveCount(0);
});
test("deleting a connection names the agents that lose it", async ({ page }) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [connection];
  controls.assistantConnections.add(connection.id);
  controls.assistantAffected = {
    agents: [
      { id: "olli", name: "Olli" },
      { id: "tmp", name: "Tmp" },
    ],
    teamMembers: 3,
  };
  await page.goto(baseURL + "/accounts");
  await page.getByRole("button", { name: "Delete Agent router", exact: true }).click();
  const removal = page.getByRole("dialog");
  await removal.getByRole("button", { name: "Delete connection", exact: true }).click();
  await expect(removal).toContainText(
    "Olli and Tmp use this provider connection. They stop working until you choose another provider connection for them.",
  );
  await expect(removal).toContainText("Also used by 3 temporary team members.");
});
