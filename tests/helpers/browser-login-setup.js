import { request } from "@playwright/test";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Only provision the disposable server owned by Playwright, never an external app.
export default async function setup(config) {
  const { baseURL, storageState } = config.projects[0].use;
  const client = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  try {
    const response = await client.post("/auth/setup", {
      data: { username: "browser-fixture", password: randomBytes(24).toString("hex") },
    });
    if (response.status() !== 201)
      throw new Error("Disposable browser user could not be created");
    await fs.mkdir(path.dirname(storageState), { recursive: true, mode: 0o700 });
    await client.storageState({ path: storageState });
    await fs.chmod(storageState, 0o600);
  } finally {
    await client.dispose();
  }
}
