import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const origin = "http://agentpier-lan.invalid";

test("plain network HTTP creates strong Explorer upload and editor identities", async ({
  page,
}) => {
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<script type="module">
          import { requestId } from "/web/features/files/file-action-utils.js";
          import { planUploadGroup } from "/web/features/files/file-upload-group.js";
          import { createFileEditorStore } from "/web/features/files/file-editor-store.js";
          import { ChatDraft } from "/web/features/chat/chat-draft.js";
          import { browserUuid } from "/web/lib/browser-uuid.js";
          const upload = planUploadGroup(
            { directories: [], files: [{ relativePath: "a.txt", file: new File(["a"], "a.txt") }] },
            "/", { jobEntries: 10, uploadBytes: 100, jobBytes: 100 });
          const store = createFileEditorStore();
          const saves = [];
          const client = {
            readText: async path => ({ path, text: "a", encoding: "utf-8", lineEnding: "lf", bom: false, revision: "d1:" + "0".repeat(64), metadataRevision: "e1:" + "0".repeat(64) }),
            saveText: async (path, bytes, options) => {
              saves.push({ path, bytes: [...bytes], requestId: options.requestId });
              if (saves.length === 1) throw Error("reply lost");
              return { path, revision: "d1:" + "1".repeat(64), metadataRevision: "e1:" + "1".repeat(64) };
            }
          };
          const tab = await store.open(client, "home", "/a.txt");
          store.edit(tab.id, { text: "changed" });
          await store.save(tab.id);
          await store.save(tab.id);
          const values = new Map();
          const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
          const draft = new ChatDraft(storage, "scope", (_name, operation) => operation());
          await draft.change({ text: "hello" });
          const chat = await draft.enqueue(browserUuid(), []);
          const reloadRequestId = browserUuid();
          window.proof = { secure: isSecureContext, randomUUID: typeof crypto.randomUUID,
            getRandomValues: typeof crypto.getRandomValues, requestId: requestId(),
            uploadRequestId: upload.body.requestId, entryId: upload.batches[0].entries[0].id,
            batchId: upload.batches[0].batchId, tabId: tab.id, saves,
            chatId: chat.id, chatEpoch: draft.getSnapshot().epoch, reloadRequestId };
        </script>`,
      });
    const target = path.join(process.cwd(), pathname.slice(1));
    return route.fulfill({
      contentType: "text/javascript",
      body: await fs.readFile(target, "utf8"),
    });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.proof);
  const proof = await page.evaluate(() => window.proof);
  expect(proof.secure).toBe(false);
  expect(proof.randomUUID).toBe("undefined");
  expect(proof.getRandomValues).toBe("function");
  expect(proof.requestId).toMatch(
    /^\d+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(proof.uploadRequestId).toMatch(/^\d+:[0-9a-f-]{36}$/);
  for (const id of [proof.entryId, proof.batchId, proof.tabId])
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  expect(proof.saves).toHaveLength(2);
  expect(proof.saves[0].requestId).toMatch(/^\d+:[0-9a-f-]{36}$/);
  expect(proof.saves[1]).toEqual(proof.saves[0]);
  for (const id of [proof.chatId, proof.chatEpoch, proof.reloadRequestId])
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});
