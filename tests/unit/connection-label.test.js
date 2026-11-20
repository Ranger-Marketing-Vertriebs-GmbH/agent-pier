import test from "node:test";
import assert from "node:assert/strict";
import { connectionLabel } from "../../web/features/assistants/connection-label.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("labels connections with their provider", () => {
  const chatgpt = { name: "david@example.com", providerId: "openai-chatgpt" };
  for (const lang of ["de", "en"]) {
    setLanguage(lang);
    assert.equal(connectionLabel(chatgpt), "ChatGPT · david@example.com");
    assert.equal(
      connectionLabel({ name: "Openrouter", providerId: "openrouter" }),
      "OpenRouter",
    );
    assert.equal(connectionLabel({ name: "Work", providerId: "zai" }), "Z.ai API · Work");
    assert.equal(connectionLabel({ name: "Legacy" }), "Legacy");
  }
});

test("an endpoint from a listed preset is named after it, as in the connection list", () => {
  for (const [lang, custom] of [
    ["de", "Eigener Endpunkt"],
    ["en", "Custom endpoint"],
  ]) {
    setLanguage(lang);
    assert.equal(
      connectionLabel({
        name: "azure test",
        providerId: "endpoint",
        endpoint: { preset: "azure" },
      }),
      "Azure OpenAI · azure test",
    );
    assert.equal(
      connectionLabel({
        name: "box",
        providerId: "endpoint",
        endpoint: { preset: "custom" },
      }),
      `${custom} · box`,
    );
  }
});
