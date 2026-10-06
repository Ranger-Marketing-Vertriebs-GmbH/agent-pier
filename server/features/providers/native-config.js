import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { privateDirectory, problem } from "../../lib/storage.js";

export function writeTomlConfig(file, additions) {
  let current = {};
  try {
    current = parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw problem(serverMessages.providers.managedConfigInvalid, 409);
  }
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, stringify({ ...current, ...additions }), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * `applyPatchToolType` "freeform" sends apply_patch as an OpenAI grammar tool; generic
 * Responses servers (Ollama, vLLM, LM Studio, llama.cpp) only handle "function" tools.
 */
export function codexModelCatalog(
  model,
  { contextTokens, description, reasoning, applyPatchToolType = "freeform" },
) {
  return {
    models: [
      {
        slug: model.modelId,
        display_name: model.label,
        description,
        default_reasoning_level: reasoning ? "high" : "medium",
        supported_reasoning_levels: reasoning
          ? [
              { effort: "low", description: "Low" },
              { effort: "high", description: "High" },
            ]
          : [{ effort: "medium", description: "Medium" }],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        base_instructions: "",
        supports_reasoning_summaries: reasoning,
        default_reasoning_summary: "none",
        support_verbosity: false,
        apply_patch_tool_type: applyPatchToolType,
        truncation_policy: { mode: "bytes", limit: 10000 },
        context_window: contextTokens,
        max_context_window: contextTokens,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        input_modalities: ["text"],
      },
    ],
  };
}

export const glmCodexCatalog = (model) =>
  codexModelCatalog(model, {
    contextTokens: model.codexContextTokens,
    description: "GLM via Z.ai Responses API",
    reasoning: true,
  });
