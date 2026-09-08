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
      throw problem(
        "The managed provider config is invalid. Repair it before launching.",
        409,
      );
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

export function glmCodexCatalog(model) {
  return {
    models: [
      {
        slug: model.modelId,
        display_name: model.label,
        description: "GLM via Z.ai Responses API",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        base_instructions: "",
        supports_reasoning_summaries: true,
        default_reasoning_summary: "none",
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 10000 },
        context_window: model.codexContextTokens,
        max_context_window: model.codexContextTokens,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        input_modalities: ["text"],
      },
    ],
  };
}
