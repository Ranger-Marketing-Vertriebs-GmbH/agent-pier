// Hermes's browser tools have no upload (tools/browser_tool.py), so an agent with
// AgentPier's browser gets this tool (hermes-browser-upload.js).
export const browserUpload = Object.freeze({
  name: "agentpier_browser_upload",
  description:
    "Put files into a file field (input type=file) of a page open in your browser, as a person choosing files would. First call agentpier_workspace with action browser_upload_stage for each file (path, and projectId for a project folder) and pass the uploadPath values it returns as paths, unchanged; nothing else can be uploaded, and a staged file expires after six hours. selector: a CSS selector of the file field (default: the page's first input[type=file]). urlContains: part of the page's address when several pages are open. Then take a snapshot and submit the form with your browser tools.",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 4096 },
      },
      selector: { type: "string", minLength: 1, maxLength: 1000 },
      urlContains: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["paths"],
    additionalProperties: false,
  },
});
