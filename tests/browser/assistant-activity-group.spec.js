import { test, expect } from "@playwright/test";
import { setup } from "./assistant-shell-fixture.js";
import { openChat } from "./assistant-ssh-fixture.js";

// SCREENSHOTS=dir saves the collapsed and opened group for a pull request.
const shots = process.env.SCREENSHOTS;

const note = (n, extra = {}) => ({
  id: `ssh-run:r${n}`,
  role: "event",
  event: "ssh-run",
  hostName: "proxmox-2",
  command: `pvesh get /nodes/proxmox-2/qemu/${100 + n}/status/current`,
  commandPreview: `pvesh get /nodes/proxmox-2/qemu/${100 + n}/status/current`,
  outcome: "done",
  exitCode: 0,
  durationMs: 800 + n * 10,
  timestamp: 1760608800000 + n * 1000,
  runId: null,
  ...extra,
});
const text = (id, role, words) => ({
  id,
  role,
  text: words,
  timestamp: 1760608790000 + (role === "user" ? 0 : 60000),
});
const transcript = [
  text("u1", "user", "Check every VM on proxmox-2."),
  ...Array.from({ length: 13 }, (_, n) =>
    note(n + 1, n === 6 ? { outcome: "exit", exitCode: 2 } : {}),
  ),
  text("r1", "assistant", "12 of 13 VMs are running; VM 107 reported an error."),
  note(20, { hostName: "nas-01", command: "df -h", commandPreview: "df -h" }),
];

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
])
  test(`consecutive SSH calls fold into one group that keeps failures visible (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.route(/\/messages(\?|$)/, (route) =>
      route.fulfill({ json: { messages: transcript, requests: [], stale: false } }),
    );
    await openChat(page);
    const group = page.locator("[data-activity-group]");
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute("data-activity-group", "13");
    const toggle = group.getByRole("button").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText(/SSH activity\s*13 calls · proxmox-2\s*1 failed/);
    await expect(group.locator(".status-chip").first()).toHaveClass(/status-chip-error/);
    await expect(group.locator("[data-ssh-run]")).toHaveCount(0);
    // The single run after the reply stays its own row.
    await expect(
      page.locator(".assistant-transcript > [role=log] > [data-ssh-run]"),
    ).toHaveCount(1);
    const overflow = () =>
      page.evaluate(
        () =>
          document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBe(0);
    if (shots) await page.screenshot({ path: `${shots}/group-collapsed-${name}.png` });

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = group.locator("[data-ssh-run]");
    await expect(rows).toHaveCount(13);
    await expect(group.locator("[data-ssh-run=exit]")).toContainText("Exit 2");
    const failed = group.locator("[data-ssh-run=exit]").getByRole("button").first();
    await failed.click();
    await expect(group.locator("[data-ssh-run=exit] pre")).toHaveText(
      "pvesh get /nodes/proxmox-2/qemu/107/status/current",
    );
    expect(await overflow()).toBe(0);
    if (shots) {
      await rows.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/group-expanded-${name}.png` });
    }
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rows).toHaveCount(0);
  });
