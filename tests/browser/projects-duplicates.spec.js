import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

test.use({ locale: "en-GB" });

const older = { id: "m9", name: "notes", entries: 3, createdAt: "2026-01-02T10:00:00Z" };

test("an older entry of a folder stays hidden and merges only after confirmation", async ({
  page,
}) => {
  let merged = false;
  const posts = [];
  await hubFixture(page, {
    async intercept(route, url, method) {
      if (url.pathname === "/api/memory/projects" && method === "GET") {
        const notes = { id: "m2", name: "notes", cwd: "/work/notes", entryCount: 0 };
        await route.fulfill({
          json: {
            projects: [
              { id: "m1", name: "agent-pier", cwd: "/work/agent-pier", entryCount: 4 },
              merged
                ? { ...notes, entryCount: 3 }
                : { ...notes, olderDuplicates: [older] },
              ...(merged
                ? []
                : [{ ...notes, id: "m9", entryCount: 3, duplicateOf: "m2" }]),
            ],
          },
        });
        return true;
      }
      if (url.pathname === "/api/memory/projects/m2/merge" && method === "GET") {
        expect(url.searchParams.get("olderId")).toBe("m9");
        await route.fulfill({
          json: {
            olderId: "m9",
            entries: 3,
            capabilities: 1,
            sshAccess: 2,
            artifacts: 4,
            verification: 1,
            sessions: 2,
          },
        });
        return true;
      }
      if (url.pathname === "/api/memory/projects/m2/merge" && method === "POST") {
        posts.push(route.request().postDataJSON());
        merged = true;
        await route.fulfill({ json: { id: "m2", name: "notes", cwd: "/work/notes" } });
        return true;
      }
      return false;
    },
  });
  await page.goto(base + "/projects/m2");
  const list = page.getByRole("navigation", { name: "Projects", exact: true });
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(list.getByRole("button", { name: /^notes/ })).toHaveCount(1);
  const action = page.getByRole("button", { name: "Merge older entry" });
  await action.click();
  let dialog = page.getByRole("dialog", { name: "Merge older entry" });
  await expect(
    dialog.getByRole("list", { name: "What moves" }).getByRole("listitem"),
  ).toHaveText([
    "Memory entries: 3",
    "Memory accesses of sessions: 1",
    "SSH keys and hosts: 2",
    "Artifacts: 4",
    "Verification steps: 1",
    "Sessions: 2",
  ]);
  await expect(dialog.getByRole("alert")).toContainText(
    "SSH access and the permissions of sessions",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([]);
  await action.click();
  dialog = page.getByRole("dialog", { name: "Merge older entry" });
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([{ olderId: "m9", entries: 3 }]);
  await expect(page.getByRole("button", { name: "Merge older entry" })).toHaveCount(0);
  await expect(list.getByRole("button")).toHaveCount(2);
});

test("a project without older entries offers no merge", async ({ page }) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m2");
  await expect(page.getByRole("heading", { name: "notes", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge older entry" })).toHaveCount(0);
});
