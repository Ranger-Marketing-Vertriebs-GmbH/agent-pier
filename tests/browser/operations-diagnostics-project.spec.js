import { test, expect } from "../helpers/browser-test.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { Doctor } from "../../server/features/operations/doctor.js";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-US" });
test("project diagnostics lists the memory projects that Doctor checks", async ({
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
      page.getByText("The project folder exists.", { exact: true }),
    ).toBeVisible();
    expect(submitted).toEqual([{ scope: "project", projectId: scope.id, deep: false }]);
    // A repositories.json entry is no project of the Projects page (W8 B3).
    await expect(async () => {
      await doctor.run({ scope: "project", projectId: repository.id });
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
