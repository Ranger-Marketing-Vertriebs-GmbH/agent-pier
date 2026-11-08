// agentpier_craft (craft/agent-craft.js). The plugin stands alone, so the stacks are
// a copy of craft/craft-stacks.js (a unit test keeps both equal); a start creates the
// rebuild's folder and starts Craft Anything within index.js toolTimeouts.craft.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });

export const craftStackChoices = [
  "Builder's choice",
  "Plain HTML and CSS",
  "React + TypeScript (Vite)",
  "Next.js + TypeScript",
  "Python",
  "Electron",
  "Rust (console)",
  "Rust + egui (eframe)",
  "unity",
  "unreal",
  "godot",
];

export const craftDefinition = {
  craft: {
    description:
      "Start a Craft Anything rebuild for the owner, or read the status of one you started. Use it only in the owner's own chat when the owner asks you to rebuild or recreate an app, a website or a file (FORBIDDEN otherwise: do not retry). start takes request (what to build, in the owner's words), optionally target (a web address or an absolute path of what to rebuild) and stack (default Builder's choice); the owner's defaults choose the account, the mode and auto mode. Each rebuild gets a new project folder in the owner's default working directory and runs inside AgentPier. It returns id, name, status, step, note, projectId, folder, openQuestions and link. status (id) reads the same fields of a rebuild you started. The owner answers every question and approval of a rebuild in AgentPier (openQuestions counts them); you never see or answer them. Tell the owner the rebuild started and where to follow it. CRAFT_NOT_INSTALLED: Craft Anything is not installed; tell the owner. AGENT_LOOP_LIMIT: stop and tell the owner.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status"] },
        request: text(8000),
        target: text(2048),
        stack: { type: "string", enum: craftStackChoices },
        id: text(100),
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
