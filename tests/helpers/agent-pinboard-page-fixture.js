import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "./application.js";
import { png } from "./craft-pictures.js";

export const gallery = `<!doctype html><title>Gallery</title>
<link rel="stylesheet" href="style/site.css">
<a href="bilder/01.png"><img src="bilder/01.png" alt="one"></a>
<a href="szenen.html">Scenes</a>`;

/**
 * The real app with one agent whose workspace holds a gallery page `site/index.html`
 * with an image, a style sheet and a sibling page, pinned straight into its store.
 * `frame(url)` fetches as the reader's sandboxed frame does: no cookie, cross-site,
 * no origin (a font sends "null").
 */
export async function pageFixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  const agent = service.store.createAssistant({
    name: "Painter",
    model: { connectionId: "c", modelId: "m" },
  });
  const store = service.pinboard.store;
  const workspace = path.join(service.attachments.config.workspaces, agent.id);
  const file = (name, body) => {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  };
  file("site/index.html", gallery);
  file("site/szenen.html", "<!doctype html><title>Scenes</title><p>Scenes</p>");
  file("site/bilder/01.png", png(4, 4));
  file("site/style/site.css", "body { color: #333 }");
  const now = () => new Date().toISOString();
  const listId = store.createList(agent.id, { title: "Galleries" }, now()).id;
  const pin = (relative, { identity = null, root = "workspace" } = {}) =>
    store.pin(
      agent.id,
      listId,
      {
        name: path.basename(relative),
        note: "",
        root,
        path: relative,
        admitConversationId: null,
        identity,
      },
      now(),
    ).entry;
  const base = `/api/assistants/${agent.id}/pinboard`;
  const view = async () => {
    const response = await f.request(base);
    assert.equal(response.status, 200);
    const board = await response.json();
    return board.lists.flatMap((list) => list.entries);
  };
  const open = (entry, headers = {}) =>
    f.request(`${base}/entries/${entry.id}/page`, { headers });
  // The page's URL below a new grant, as the reader's frame opens it.
  const grant = async (entry) => {
    const response = await open(entry);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return (await response.json()).url;
  };
  const frame = (url, headers = {}) =>
    f.request(url, {
      origin: null,
      headers: { cookie: "", "sec-fetch-site": "cross-site", ...headers },
    });
  return { ...f, service, agent, store, workspace, file, pin, view, open, grant, frame };
}

/** `relative` resolved against the last segment of a page grant's URL. */
export const sibling = (url, relative) => url.replace(/[^/]+$/, relative);
