import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { Doctor } from "../../server/features/operations/doctor.js";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-US" });
test("project diagnostics selects the repository identity accepted by Doctor", async ({
  page,
}, testInfo) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "doctor-browser-")),
  );
  const dataDir = path.join(root, "data"),
    project = path.join(root, "project");
  await fs.mkdir(project);
  const memory = new ProjectMemory({ dataDir });
  try {
    const scope = await memory.register(project);
    const repository = { id: randomUUID(), name: "Fixture project", path: project };
    expect(repository.id).not.toBe(scope.id);
    await fs.writeFile(
      path.join(dataDir, "repositories.json"),
      JSON.stringify({ projects: [repository] }),
    );
    const doctor = new Doctor({
      dataDir,
      home: root,
      command: async () => ({ code: 0, stdout: "fixture 1.0" }),
      ptyCheck: async () => true,
    });
    await operationsFixture(page);
    await page.route("**/api/memory/projects", (route) =>
      route.fulfill({ json: { projects: [{ ...scope, name: repository.name }] } }),
    );
    await page.route("**/api/repositories", (route) =>
      route.fulfill({ json: { projects: [repository], credentials: [] } }),
    );
    const submitted = [];
    await page.route("**/api/operations/doctor", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: { report: null } });
      const body = route.request().postDataJSON();
      submitted.push(body);
      try {
        await route.fulfill({ json: { report: await doctor.run(body) } });
      } catch (error) {
        await route.fulfill({
          status: error.status || 500,
          json: { error: error.message },
        });
      }
    });
    await page.goto(baseURL + "/settings/diagnostics");
    await page.getByRole("combobox", { name: "Check scope", exact: true }).click();
    await page.getByRole("option", { name: "Project", exact: true }).click();
    await page.getByRole("combobox", { name: "Project", exact: true }).click();
    await page.getByRole("option", { name: "Fixture project", exact: true }).click();
    await page.getByRole("button", { name: "Run checks", exact: true }).click();
    await expect(
      page.getByText("Project directory exists.", { exact: true }),
    ).toBeVisible();
    expect(submitted).toEqual([
      { scope: "project", projectId: repository.id, deep: false },
    ]);
    await expect(async () => {
      await doctor.run({ scope: "project", projectId: scope.id });
    }).rejects.toMatchObject({ status: 404 });
    await page.screenshot({
      path: testInfo.outputPath("diagnostics-project-en.png"),
      fullPage: true,
    });
  } finally {
    memory.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
