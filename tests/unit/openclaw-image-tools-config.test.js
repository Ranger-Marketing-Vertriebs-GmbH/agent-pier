import test from "node:test";
import assert from "node:assert/strict";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import {
  webToolsAvailability,
  webToolsSections,
  webToolsSignature,
} from "../../server/features/assistants/openclaw-config/web-tools.js";
import {
  capabilityKeys,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";

const paths = { workspaces: "/data/workspaces", logs: "/data/logs" };
const artist = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { createImages: true },
};
const plain = { id: "a2", runtimeAgentId: "ap-a2", capabilities: { memory: true } };
// A task member whose lead granted it image creation.
const member = {
  id: "m1",
  runtimeAgentId: "ap-m1",
  teamMemberId: "t1",
  lifetime: "task",
  inherited: {
    capabilities: { createImages: true },
    skills: [],
    shell: "off",
    ssh: false,
  },
};
const webTools = (ready) => ({
  search: { provider: "duckduckgo", unavailable: true },
  browser: { available: false },
  searchPlugins: {},
  images: { ready },
});
function compile(profiles, tools, defaults = {}) {
  return compileOpenClawConfig({
    existing: {
      agents: {
        defaults,
        entries: Object.fromEntries(
          profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
        ),
      },
    },
    paths,
    port: 20000,
    token: "gateway-token",
    teams: {
      directory: "/private/plugin",
      connection: { url: "http://127.0.0.1:1235", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles,
    },
    webTools: tools,
  });
}

test("image creation is a capability of its own, apart from reading images", () => {
  assert.ok(capabilityKeys.includes("createImages"));
  const tools = profileTools(artist, true, true, true, { createImages: true });
  assert.ok(tools.includes("image_generate"));
  assert.equal(tools.includes("view_image"), false);
  assert.equal(
    profileTools(plain, true, true, true, { createImages: true }).includes(
      "image_generate",
    ),
    false,
  );
  // Without a ready ChatGPT account the tool is withheld, as for a missing browser.
  assert.equal(
    profileTools(artist, true, true, true, { createImages: false }).includes(
      "image_generate",
    ),
    false,
  );
  // A member gets it only as its lead's grant.
  assert.ok(
    profileTools(member, true, true, true, { createImages: true }).includes(
      "image_generate",
    ),
  );
});

test("a ready ChatGPT account compiles the image tool and OpenAI's image model", () => {
  assert.equal(webToolsAvailability(webTools(true)).createImages, true);
  assert.equal(webToolsAvailability(webTools(false)).createImages, false);
  assert.equal(webToolsAvailability({}).createImages, false);
  const config = compile([artist, plain], webTools(true));
  assert.ok(config.tools.allow.includes("image_generate"));
  assert.deepEqual(config.agents.defaults.mediaModels, {
    image: { primary: "openai/gpt-image-2", timeoutMs: 180000 },
  });
  assert.ok(config.agents.entries["ap-a1"].tools.allow.includes("image_generate"));
  assert.equal(
    config.agents.entries["ap-a2"].tools.allow.includes("image_generate"),
    false,
  );
});

test("no account, or no agent creating images, compiles neither", () => {
  for (const [profiles, ready] of [
    [[artist], false],
    [[plain], true],
  ]) {
    const config = compile(profiles, webTools(ready));
    assert.equal(config.tools.allow.includes("image_generate"), false);
    assert.equal(config.agents.defaults.mediaModels, undefined);
  }
  assert.deepEqual(
    webToolsSections({ profiles: [plain], webTools: webTools(true), port: 0 }).media,
    undefined,
  );
  // An image model an earlier start compiled does not survive; others stay.
  const stale = compile([plain], webTools(true), {
    mediaModels: { image: { primary: "openai/gpt-image-2" }, video: { primary: "x/y" } },
  });
  assert.deepEqual(stale.agents.defaults.mediaModels, { video: { primary: "x/y" } });
  const only = compile([plain], webTools(true), {
    mediaModels: { image: { primary: "openai/gpt-image-2" } },
  });
  assert.equal(only.agents.defaults.mediaModels, undefined);
});

test("an account that becomes ready changes what a start compiles", () => {
  assert.notEqual(
    webToolsSignature({ profiles: [artist], webTools: webTools(true) }),
    webToolsSignature({ profiles: [artist], webTools: webTools(false) }),
  );
  // Without an agent that creates images, the account changes nothing.
  assert.equal(
    webToolsSignature({ profiles: [plain], webTools: webTools(true) }),
    webToolsSignature({ profiles: [plain], webTools: webTools(false) }),
  );
});
