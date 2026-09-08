import { normalizeOpenRouter, normalizeZai } from "./catalog-normalization.js";

const fetchedAt = "2026-09-06T00:00:00.000Z";
const routerModel = (id, name, context, routing, output) => ({
  id,
  name,
  context_length: context,
  top_provider: { context_length: routing, max_completion_tokens: output },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools", "reasoning"],
});
const zaiModel = (id, name) => ({
  id,
  name,
  tool_call: true,
  reasoning: true,
  limit: { context: 1000000, output: 131072 },
  modalities: { input: ["text"], output: ["text"] },
});

export function catalogSnapshot() {
  const models = {
    "glm-5.3": zaiModel("glm-5.3", "GLM-5.3"),
    "glm-5.3-flash": zaiModel("glm-5.3-flash", "GLM-5.3-Flash"),
  };
  const zai = { zai: { models }, "zai-coding-plan": { models } };
  return {
    openrouter: normalizeOpenRouter(
      {
        data: [
          routerModel(
            "anthropic/claude-sonnet-4.6",
            "Claude Sonnet 4.6",
            1000000,
            1000000,
            128000,
          ),
          routerModel("z-ai/glm-5.3", "GLM-5.3", 1310720, 1048576, 262144),
          routerModel("z-ai/glm-5.3-flash", "GLM-5.3-Flash", 1310720, 1048576, 131072),
        ],
      },
      fetchedAt,
    ),
    zai: normalizeZai(zai, "zai", fetchedAt),
    "zai-coding-plan": normalizeZai(zai, "zai-coding-plan", fetchedAt),
  };
}
