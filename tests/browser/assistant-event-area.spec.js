import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

// The main chat of "home" with a routine result, a failed routine, a hook event and
// a reminder: only the reminder stays a message, the rest waits in the shut
// "Events" group. The hook event's payload tries to inject HTML.
const hookId = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
const now = Date.now();
const reply = "Disk on **nas** is 95% full.\n\nI cleared the package cache.";
const events = [
  {
    id: "hook:e1",
    source: "hook",
    name: "Zabbix",
    sender: "Zabbix server",
    at: now - 60_000,
    status: "done",
    duplicates: 2,
    firstLine: "Disk on nas is 95% full.",
    reply,
    hookId,
    eventId: "e1",
  },
  {
    id: "routine:r1",
    source: "routine",
    name: "AI News Update",
    at: now - 120_000,
    status: "done",
    firstLine: "AI news, October 14",
    reply: "**AI news, October 14**\n\n- OpenClaw ships scheduled tool caps.",
  },
  {
    id: "routine:r2",
    source: "routine",
    name: "Weekly review",
    at: now - 180_000,
    status: "failed",
    firstLine: "",
    notes: ["ssh_refused"],
  },
];
const detail = {
  receivedAt: new Date(now - 60_000).toISOString(),
  size: 2048,
  contentType: "application/json",
  source: "tailscale",
  payload: '{\n  "message": "<b>x</b>",\n  "host": "nas"\n}',
  payloadCut: false,
  activity: [{ tool: "exec", state: "done", label: "df -h" }],
  coding: [
    {
      actionId: "c1",
      state: "running",
      runUrl: "http://127.0.0.1:4380/pipelines/runs/r-1",
    },
  ],
  remote: [{ actionId: "s1", kind: "ssh", host: "nas", state: "completed" }],
  notified: { push: true, telegram: false },
  reply,
};
const words = {
  en: {
    group: "Events",
    summary: "3 events · 3 new",
    seen: "3 events",
    failed: "1 failed",
    hookRow: "Zabbix · Zabbix server",
    duplicates: "2 duplicates",
    incoming: "What came in",
    did: "What the agent did",
    step: "Command · df -h · Done",
    remote: "SSH on nas · Completed",
    push: "Push notice sent",
    openRun: "Open run",
    refused: "SSH refused: host not trusted for routines",
  },
  de: {
    group: "Ereignisse",
    summary: "3 Ereignisse · 3 neu",
    seen: "3 Ereignisse",
    failed: "1 fehlgeschlagen",
    hookRow: "Zabbix · Zabbix server",
    duplicates: "2 Duplikate",
    incoming: "Was ankam",
    did: "Was der Agent getan hat",
    step: "Befehl · df -h · Erledigt",
    remote: "SSH auf nas · Abgeschlossen",
    push: "Push-Benachrichtigung gesendet",
    openRun: "Lauf öffnen",
    refused: "SSH abgelehnt: Host ist für Routinen nicht freigegeben",
  },
};

async function eventAreaSetup(page, language) {
  const state = await chatFixture(page, {
    language,
    history: {
      messages: [
        { id: "question", role: "user", text: "Watch my NAS, please." },
        { id: "answer", role: "assistant", text: "I will tell you what the hook says." },
        {
          id: "reminder",
          role: "assistant",
          text: "Time to water the plants.",
          scheduled: { kind: "reminder", name: "Plants" },
        },
      ],
      requests: [],
      events,
      stale: false,
    },
  });
  const reads = [];
  await page.route(/\/api\/assistants\/home\/hooks\//, (route) => {
    reads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: detail });
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  return { state, reads };
}

const group = (page) => page.locator(".agent-event-group");
const groupHead = (page) => group(page).locator("> .activity-row-head");

for (const language of ["en", "de"])
  test(`routine and hook events wait in the shut Events group (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    await eventAreaSetup(page, language);
    await expect(groupHead(page)).toHaveAttribute("aria-expanded", "false");
    await expect(groupHead(page).locator(".activity-row-label")).toHaveText(t.group);
    await expect(groupHead(page).locator(".activity-row-detail")).toHaveText(t.summary);
    // The failed routine stays visible while the group is shut.
    await expect(groupHead(page).locator(".status-chip")).toHaveText(t.failed);
    await expect(group(page).locator(".agent-event-row").first()).toBeHidden();
    // Results are not messages; the reminder is.
    await expect(page.locator(".assistant-message")).toHaveCount(3);
    await expect(page.locator(".assistant-transcript")).not.toContainText("AI news");
    await expect(page.locator(".assistant-transcript")).not.toContainText("Disk on");
    await expect(
      page.locator(".assistant-message").filter({ hasText: "Time to water the plants." }),
    ).toBeVisible();

    await groupHead(page).click();
    const rows = group(page).locator(".agent-event-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator(".activity-row-label")).toHaveText(t.hookRow);
    await expect(rows.nth(0).locator(".activity-row-detail")).toContainText(t.duplicates);
    await expect(rows.nth(2).locator(".activity-row-detail")).toHaveText(t.refused);
    // Opening marks everything seen, also after a reload.
    await expect(groupHead(page).locator(".activity-row-detail")).toHaveText(t.seen);
    await page.reload();
    await expect(groupHead(page).locator(".activity-row-detail")).toHaveText(t.seen);
    await expect(groupHead(page).locator(".status-chip")).toHaveCount(0);
  });

for (const language of ["en", "de"])
  test(`a hook row shows its payload as text, its steps and its reply (${language})`, async ({
    page,
  }) => {
    const t = words[language];
    const { reads } = await eventAreaSetup(page, language);
    await groupHead(page).click();
    const row = group(page).locator('.agent-event-row[data-event-source="hook"]');
    await row.locator(".activity-row-head").click();
    const code = row.locator("pre.activity-row-code");
    await expect(code).toContainText('"message": "<b>x</b>"');
    // Plain text, never Markdown or HTML.
    await expect(row.locator(".activity-row-body b")).toHaveCount(0);
    expect(reads).toEqual([`/api/assistants/home/hooks/${hookId}/events/e1`]);
    await expect(row.getByRole("heading", { name: t.incoming })).toBeVisible();
    const did = row.locator(".agent-event-did");
    await expect(did.getByRole("heading", { name: t.did })).toBeVisible();
    await expect(did.locator("li").nth(0)).toHaveText(t.step);
    await expect(did.locator("li").nth(2)).toHaveText(t.remote);
    await expect(did.locator("li").nth(3)).toHaveText(t.push);
    await expect(did.getByRole("link", { name: t.openRun })).toHaveAttribute(
      "href",
      "/pipelines/runs/r-1",
    );
    // The reply is the agent's Markdown.
    await expect(row.locator(".agent-event-reply strong")).toHaveText("nas");
    await expect(row.locator(".activity-row-facts")).toContainText("Zabbix server");
    await expect(row.locator(".activity-row-facts")).toContainText("2");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

test("event area screenshots", async ({ page }, info) => {
  test.skip(!process.env.EVENT_AREA_SHOTS, "Screenshots are taken on request.");
  await eventAreaSetup(page, "en");
  await expect(groupHead(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath("d-events-shut.png") });
  await groupHead(page).click();
  const row = group(page).locator('.agent-event-row[data-event-source="hook"]');
  await row.locator(".activity-row-head").click();
  await expect(row.locator("pre.activity-row-code")).toBeVisible();
  await page.screenshot({ path: info.outputPath("e-events-hook-open.png") });
});

// AGENTPIER-246: a routine run's SSH rows wait inside its event row; the transcript
// keeps only the conversation, and a pending approval card stays actionable there.
const sshNote = {
  id: "ssh-run:s9",
  role: "event",
  event: "ssh-run",
  hostName: "proxmox-2",
  commandPreview: "qm guest exec 109 -- uptime",
  command: "qm guest exec 109 -- uptime",
  outcome: "done",
  exitCode: 0,
  durationMs: 1200,
  timestamp: now - 240_000,
  runId: null,
};
const approval = {
  id: "a1",
  revision: 1,
  assistantId: "home",
  conversationId: "dinner",
  state: "awaiting_approval",
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 600_000).toISOString(),
  payload: {
    action: "ssh",
    accessId: "11111111-1111-4111-8111-111111111111",
    hostName: "opnsense",
    host: "opnsense.invalid",
    port: 22,
    username: "root",
    hostFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
    projectId: null,
    projectName: null,
    command: "uptime",
    timeoutSeconds: 30,
    originClass: "owner",
  },
};

async function routineSshSetup(page) {
  const state = await chatFixture(page, {
    actions: [approval],
    history: {
      messages: [
        { id: "question", role: "user", text: "Watch proxmox-2, please." },
        { id: "answer", role: "assistant", text: "I will check it every few minutes." },
      ],
      requests: [],
      events: [
        {
          id: "routine:zabbix",
          source: "routine",
          name: "Zabbix check",
          at: now - 230_000,
          status: "done",
          firstLine: "VM 109 is healthy.",
          reply: "VM 109 is healthy.",
          runNotes: [sshNote],
        },
      ],
      stale: false,
    },
  });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  return state;
}

test("a routine run's SSH row shows only inside its shut event row", async ({ page }) => {
  await routineSshSetup(page);
  const transcript = page.locator(".assistant-transcript");
  await expect(transcript.locator(".assistant-message")).toHaveCount(2);
  await expect(transcript.locator(".ssh-run-note")).toHaveCount(0);
  await expect(transcript).not.toContainText("qm guest exec");
  await expect(groupHead(page)).toHaveAttribute("aria-expanded", "false");
  await expect(group(page).locator(".ssh-run-note")).toBeHidden();

  await groupHead(page).click();
  const row = group(page).locator('.agent-event-row[data-event-source="routine"]');
  await row.locator("> .activity-row-head").click();
  const did = row.locator(".agent-event-did");
  await expect(did.getByRole("heading", { name: "What the agent did" })).toBeVisible();
  const note = did.locator(".ssh-run-note");
  await expect(note.locator(".activity-row-label")).toHaveText("SSH on proxmox-2");
  await expect(note.locator(".activity-row-detail")).toContainText("qm guest exec 109");
  await expect(row.locator(".agent-event-reply")).toContainText("VM 109 is healthy.");
  // The transcript is unchanged by opening the area.
  await expect(transcript.locator(".ssh-run-note")).toHaveCount(0);
});

test("a pending approval card stays actionable beside the event area", async ({
  page,
}) => {
  await routineSshSetup(page);
  const card = page.getByRole("article", { name: "SSH command" });
  await expect(card).toBeVisible();
  await expect(group(page).getByRole("article", { name: "SSH command" })).toHaveCount(0);
  const allow = card.getByRole("button", { name: "Allow once on opnsense" });
  await expect(allow).toBeEnabled();
});

test("routine SSH screenshot", async ({ page }, info) => {
  test.skip(!process.env.EVENT_AREA_SHOTS, "Screenshots are taken on request.");
  await routineSshSetup(page);
  await page.screenshot({ path: info.outputPath("f-routine-ssh-shut.png") });
  await groupHead(page).click();
  const row = group(page).locator('.agent-event-row[data-event-source="routine"]');
  await row.locator("> .activity-row-head").click();
  await expect(row.locator(".ssh-run-note")).toBeVisible();
  await page.screenshot({ path: info.outputPath("g-routine-ssh-open.png") });
});
