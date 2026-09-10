import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function fixture(page) {
  const uploads = [];
  let fail = true;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let result = {};
    if (url.pathname === "/api/state")
      result = {
        tools: [{ id: "claude", name: "Claude Code", installed: true }],
        accounts: [{ id: "local", name: "Claude", tool: "claude", kind: "local" }],
        sessions: [
          {
            id: "upload-recovery",
            name: "Uploads",
            tool: "claude",
            accountId: "local",
            status: "running",
            cwd: "/tmp",
          },
        ],
        home: "/tmp",
      };
    else if (url.pathname.endsWith("/chat/attachments")) {
      const name = url.searchParams.get("name");
      uploads.push(name);
      if (name === "retry.txt" && fail)
        return route.fulfill({ status: 503, json: { error: "Verbindung unterbrochen" } });
      result = { name, path: `/tmp/uploads/${name}` };
    } else if (url.pathname.endsWith("/chat"))
      result = {
        availability: "ready",
        providerSessionId: "native",
        messages: [],
        tasks: [],
      };
    await route.fulfill({ json: result });
  });
  await page.goto(`${baseURL}/sessions/upload-recovery/chat`);
  return {
    uploads,
    succeed: () => {
      fail = false;
    },
  };
}

test("failed file survives reload and retries individually without repeating completed files", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setInputFiles(
    'input[type="file"]',
    ["good.txt", "retry.txt"].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(name),
    })),
  );
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  expect(f.uploads).toEqual(["good.txt", "retry.txt"]);
  await page.getByLabel("Nachricht", { exact: true }).fill("Dateien prüfen");
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  await expect(page.getByText("good.txt", { exact: true })).toBeVisible();
  expect(f.uploads).toEqual(["good.txt", "retry.txt"]);
  f.succeed();
  await page.getByRole("button", { name: "Erneut hochladen: retry.txt" }).click();
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  expect(f.uploads).toEqual(["good.txt", "retry.txt", "retry.txt"]);
  await page.reload();
  await expect(page.getByText("retry.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Erneut hochladen/ })).toHaveCount(0);
});

test("removing an interrupted file persists and unblocks sending", async ({ page }) => {
  await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  await page.getByLabel("Nachricht", { exact: true }).fill("Ohne Datei");
  await page.getByRole("button", { name: "Anhang entfernen: retry.txt" }).click();
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByText("retry.txt", { exact: true })).toHaveCount(0);
});

test("storage failure prevents uploading an unprotected file", async ({ page }) => {
  const f = await fixture(page);
  await page.evaluate(() => {
    IDBFactory.prototype.open = () => {
      throw new Error("quota");
    };
  });
  await page.setInputFiles('input[type="file"]', {
    name: "good.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("test"),
  });
  await expect(
    page.getByText("Datei konnte nicht für die Wiederherstellung gespeichert werden."),
  ).toBeVisible();
  expect(f.uploads).toEqual([]);
});

test("reloading during a transfer restores every selected file without another POST", async ({
  page,
}) => {
  const f = await fixture(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/chat/attachments?**", async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: "Interruption" } }).catch(() => {});
  });
  await page.setInputFiles(
    'input[type="file"]',
    ["first.txt", "second.txt"].map((name) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(name),
    })),
  );
  await expect(page.getByRole("progressbar", { name: "first.txt" })).toBeVisible();
  await page.reload();
  release();
  await expect(page.getByRole("button", { name: /Erneut hochladen:/ })).toHaveCount(2);
  expect(f.uploads).toEqual([]);
});

test("a stored upload receipt finishes locally without uploading the file twice", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("agentpier.chat.uploads.v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("files", "readwrite");
          const store = transaction.objectStore("files");
          const records = store.getAll();
          records.onsuccess = () => {
            const entry = records.result[0];
            store.put({
              ...entry,
              receipt: {
                key: "/tmp/uploads/retry.txt",
                name: "retry.txt",
                path: "/tmp/uploads/retry.txt",
              },
            });
          };
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Erneut hochladen: retry.txt" }).click();
  await expect(page.getByRole("button", { name: /Erneut hochladen:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  expect(f.uploads).toEqual(["retry.txt"]);
});

test("a delayed restore cannot resurrect a successfully retried upload", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  const retry = page.getByRole("button", { name: "Erneut hochladen: retry.txt" });
  await expect(retry).toBeVisible();
  await page.evaluate(() => {
    const request = navigator.locks.request.bind(navigator.locks);
    let delay = true;
    navigator.locks.request = async (...args) => {
      const hold = delay && args[0].startsWith("agentpier.upload:");
      if (hold) delay = false;
      const result = await request(...args);
      if (hold)
        await new Promise((resolve) => {
          window.releaseUploadRestore = resolve;
        });
      return result;
    };
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => page.evaluate(() => !!window.releaseUploadRestore)).toBe(true);
  f.succeed();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await page.evaluate(async () => {
    window.releaseUploadRestore();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(retry).toHaveCount(0);
  expect(f.uploads).toEqual(["retry.txt", "retry.txt"]);
});

test("two tabs retry the same interrupted file only once", async ({ page, context }) => {
  const first = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(
    page.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  const other = await context.newPage();
  const second = await fixture(other);
  await expect(
    other.getByRole("button", { name: "Erneut hochladen: retry.txt" }),
  ).toBeVisible();
  first.succeed();
  second.succeed();
  await Promise.all(
    [page, other].map((tab) =>
      tab.getByRole("button", { name: "Erneut hochladen: retry.txt" }).click(),
    ),
  );
  await expect(page.getByRole("button", { name: /Erneut hochladen:/ })).toHaveCount(0);
  await expect(other.getByRole("button", { name: /Erneut hochladen:/ })).toHaveCount(0);
  expect([...first.uploads, ...second.uploads]).toEqual(["retry.txt", "retry.txt"]);
});

test("reload cleans an upload receipt already committed to the draft without duplicate chips or another upload", async ({
  page,
}) => {
  const f = await fixture(page);
  // Model a page closing after the draft commit but before IndexedDB cleanup.
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key) {
      return this.name === "files" ? this.get(key) : remove.call(this, key);
    };
  });
  await page.setInputFiles('input[type="file"]', {
    name: "good.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("durable"),
  });
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Datei hinzufügen", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".chat-upload-pending")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Anhang entfernen: good.txt", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Senden", exact: true })).toBeEnabled();
  expect(f.uploads).toEqual(["good.txt"]);
  const count = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("agentpier.chat.uploads.v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("files", "readonly");
          const result = transaction.objectStore("files").count();
          transaction.oncomplete = () => {
            db.close();
            resolve(result.result);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  expect(count).toBe(0);
});
