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
  "Rust + macroquad",
  "Rust + egui (eframe)",
  "Phaser",
  "Bevy",
  "unity",
  "unreal",
  "godot",
];

export const craftDefinition = {
  craft: {
    description:
      "Start a Craft Anything rebuild for the owner, or read the status of one you started. Use it only in the owner's own chat when the owner asks you to rebuild or recreate an app, a website or a file (FORBIDDEN otherwise: do not retry). start takes request (what to build, in the owner's words), optionally target (the web address, http or https, of what to rebuild; local paths are refused), stack (default Builder's choice) and pictures: up to 10 screenshots or photos of the original (PNG, JPEG, WebP or GIF, at most 20 MB each) that show the look the owner expects, each { path } in your workspace (a file the owner sent in this chat, too) or { path, projectId } in a project folder you may read; pictures without a target rebuild from the pictures alone, and AgentPier hands Craft Anything a copy; the owner's defaults choose the account, the mode and auto mode. Each rebuild gets a new project folder in the owner's default working directory and runs inside AgentPier. It returns id, name, status, step, note, projectId, folder, openQuestions and link. status (id) reads the same fields of a rebuild you started. The owner answers every question and approval of a rebuild in AgentPier (openQuestions counts them); you never see or answer them. Tell the owner the rebuild started and where to follow it. CRAFT_NOT_INSTALLED: Craft Anything is not installed; tell the owner. CRAFT_PICTURE_REFUSED or CRAFT_PICTURE_NOT_FOUND: name only pictures you can read yourself. CRAFT_PICTURE_INVALID: send PNG, JPEG, WebP or GIF files of at most 20 MB. AGENT_LOOP_LIMIT: stop and tell the owner.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status"] },
        request: text(8000),
        target: text(2048),
        stack: { type: "string", enum: craftStackChoices },
        pictures: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: { path: text(4096), projectId: text(100) },
            required: ["path"],
            additionalProperties: false,
          },
        },
        id: text(100),
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
