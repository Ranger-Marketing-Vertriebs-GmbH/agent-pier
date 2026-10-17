import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readRoute, routePath } from "../../web/app/routes.js";
import { readExplorerRoute, explorerQuery } from "../../web/features/files/routes.js";
import { agentPages, agentTabs } from "../../web/features/assistants/settings-routes.js";
import { extensionTabs } from "../../web/features/extensions/routes.js";
import { accountSections } from "../../web/features/accounts/routes.js";
import { settingsTabs } from "../../web/features/operations/routes.js";
import { check, publicId } from "../helpers/property.js";

const parse = (pathname) => readRoute(new URL(pathname, "https://agentpier.test"));

test("generated public session and profile routes round-trip without changing identity", () => {
  check(
    fc.property(publicId, fc.constantFrom(null, "reader", "terminal"), (id, mode) => {
      const route = { view: "workspace", sessionId: id, mode };
      assert.deepEqual(parse(routePath(route)), route);
      for (const extensionTab of extensionTabs) {
        assert.deepEqual(
          parse(routePath({ view: "extensions", profileId: id, extensionTab })),
          { view: "extensions", profileId: id, extensionTab },
        );
      }
      assert.deepEqual(parse(`/sessions/${id}/reader`), {
        ...route,
        mode: "reader",
      });
    }),
  );
});

test("generated projects AgentBus links retain the project and pagination independently", () => {
  check(
    fc.property(publicId, fc.integer({ min: 1, max: 10000 }), (id, page) => {
      const route = {
        view: "projects",
        projectId: id,
        projectTab: "agentbus",
        query: "",
        archived: false,
        memorySort: "relevance",
        memoryPage: 1,
        busTab: "messages",
        messagePage: page,
        pipelineStatus: "",
        pipelinePage: 1,
      };
      assert.deepEqual(parse(routePath(route)), route);
    }),
  );
});

test("encoded separators, control characters and invalid leading symbols cannot create a valid session route", () => {
  const invalid = fc.oneof(
    publicId.map((id) => `../${id}`),
    publicId.map((id) => `${id}/terminal`),
    publicId.map((id) => `-${id}`),
    publicId.map((id) => `${id}\u0000`),
    publicId.map((id) => `${id}\\other`),
  );
  check(
    fc.property(invalid, (id) => {
      // A Location-like object avoids URL normalization before the application parser runs.
      assert.equal(
        readRoute({ pathname: `/sessions/${encodeURIComponent(id)}/chat` }).view,
        "missing",
      );
      assert.equal(
        readRoute({ pathname: "/", hash: `#${encodeURIComponent(id)}` }).view,
        "missing",
      );
    }),
  );
});

test("generated projects knowledge links retain repository scope, Unicode search, archive, order and page", () => {
  check(
    fc.property(
      publicId,
      fc.string({ unit: "grapheme", maxLength: 30 }),
      fc.boolean(),
      fc.constantFrom("relevance", "newest"),
      fc.integer({ min: 1, max: 100000 }),
      (projectId, query, archived, memorySort, memoryPage) => {
        const route = {
          view: "projects",
          projectId,
          projectTab: "knowledge",
          query,
          archived,
          // Without a search term the link carries no order.
          memorySort: query ? memorySort : "relevance",
          memoryPage,
          busTab: "status",
          messagePage: 1,
          pipelineStatus: "",
          pipelinePage: 1,
        };
        assert.deepEqual(parse(routePath(route)), route);
      },
    ),
  );
});

test("generated Explorer queries retain paths, filters and listing state", () => {
  const text = fc.string({ unit: "grapheme", maxLength: 40 });
  check(
    fc.property(
      text,
      text,
      text,
      fc.constantFrom("name", "type", "size", "modifiedAt"),
      fc.constantFrom("asc", "desc"),
      fc.boolean(),
      fc.integer({ min: 1, max: 999999 }),
      (filePath, file, fileFilter, fileSort, fileDirection, fileHidden, filePage) => {
        const route = {
          filePath: filePath.slice(0, 4096),
          file: file.slice(0, 4096),
          fileFilter: fileFilter.slice(0, 300),
          fileSort,
          fileDirection,
          fileHidden,
          fileHiddenExplicit: fileHidden,
          filePage,
          filePageInvalid: null,
        };
        assert.deepEqual(readExplorerRoute(explorerQuery(route)), route);
        for (const view of [
          { view: "files" },
          { view: "workspace", sessionId: "project-one", mode: "files" },
        ])
          assert.deepEqual(parse(routePath({ ...view, ...route })), {
            ...view,
            ...route,
          });
      },
    ),
  );
});

test("generated settings, agent and accounts addresses round-trip and normalise once", () => {
  check(
    fc.property(
      publicId,
      fc.constantFrom(...agentTabs, "junk", ""),
      fc.constantFrom(...Object.keys(agentPages), "junk", ""),
      fc.constantFrom(...accountSections, "junk", ""),
      fc.constantFrom(...settingsTabs, "junk"),
      (id, tab, page, section, settingsTab) => {
        const agentRoute = parse(`/agents/${id}/settings?tab=${tab}&page=${page}`);
        assert.deepEqual(parse(routePath(agentRoute)), agentRoute);
        if (agentRoute.agentPage)
          assert.equal(agentRoute.agentTab, agentPages[agentRoute.agentPage]);
        const accounts = parse(`/accounts?section=${section}&item=${id}`);
        assert.deepEqual(parse(routePath(accounts)), accounts);
        assert.equal(accounts.item === undefined, !accountSections.includes(section));
        const settings = parse(`/settings?tab=${settingsTab}`);
        assert.deepEqual(parse(routePath(settings)), settings);
      },
    ),
  );
});
