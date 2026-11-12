import { home, setupAssistantSettings } from "./assistant-settings-browser.js";

// The server's order as agent-order.js keeps it: the stored ids, applied by the page.
export async function setupAgentOrder(page, shared) {
  const data = shared || {
    assistants: [
      home({ id: "home", name: "Developer" }),
      home({ id: "calendar", name: "Calendar" }),
      home({ id: "writer", name: "Writer" }),
    ],
    groups: [],
    order: [],
    saves: [],
    assigns: [],
  };
  await setupAssistantSettings(page, { assistants: data.assistants });
  await page.route("**/api/assistants", (route) =>
    route.fulfill({
      json: {
        assistants: data.assistants,
        conversations: [],
        agentGroups: data.groups,
        agentOrder: data.order,
        activity: {},
        models: [{ id: "router", name: "Router", available: true }],
      },
    }),
  );
  await page.route("**/api/assistant-order", async (route) => {
    const { ids } = route.request().postDataJSON();
    data.saves.push(ids);
    data.order = ids;
    await route.fulfill({ json: { ids } });
  });
  await page.route(/\/api\/assistants\/[^/]+\/group$/, async (route) => {
    const body = route.request().postDataJSON(),
      id = new URL(route.request().url()).pathname.split("/")[3];
    data.assigns.push({ id, ...body });
    for (const group of data.groups)
      group.assistantIds = group.assistantIds.filter((a) => a !== id);
    data.groups.find((g) => g.id === body.groupId)?.assistantIds.push(id);
    await route.fulfill({ json: { assistantId: id, groupId: body.groupId } });
  });
  return data;
}
