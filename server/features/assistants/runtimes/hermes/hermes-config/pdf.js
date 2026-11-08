import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Read PDFs for a Hermes agent (AGENTPIER-364), as an OpenClaw agent reads them
// (pdf-policy.js, OpenClaw's pdf tool in its extraction mode): AgentPier's own `pdf`
// tool in the team plugin (pdf-tool.py, written as pdf_tool.py), not Hermes's
// read_file, which reads the text layer only. The tool reads each page's text with
// PDFium (pypdfium2, which AgentPier installs into the Hermes installation:
// hermes-pdfium.js) and renders the pages with too little text as images, within one
// pixel budget, OpenClaw's limits. Every call asks AgentPier first
// (hermes-tool-guard.js pdfGuard): files of the agent's own folder only, never
// attachments of another chat or its secrets; and which model reads:
// - its own model when that takes images: the text and page images go back to it as
//   a multimodal tool result (Hermes v0.22.5 tools/registry.py `_multimodal`), which
//   Hermes hands to a model it knows sees images (model.js `supports_vision`);
// - else the owner's PDF fallback model (pdf-model-settings.js): `fallback` below,
//   called by the tool itself, directly, never through Hermes's auxiliary client,
//   whose recovery could reach another provider; a fallback without image input
//   reads the text only, as on OpenClaw;
// - else nobody: the agent gets the text layer, scanned pages stay unread.
// A fallback is compiled while the agent's own model takes no images. Its key sits
// in .env under an AUXILIARY_*_API_KEY name, which Hermes strips from every command
// it runs (model.js endpointKeyEnv); a ChatGPT login is reached through AgentPier's
// model proxy with a credential for this agent and login (proxy-access.js).
// Hermes's hosted OCR (Firecrawl, tools/read_extract.py) stays off (home.js).

export const pdfKeyEnv = "AUXILIARY_AGENTPIER_PDF_API_KEY";
// PDFs a call reads at most, as OpenClaw's pdf tool.
export const pdfLimit = 10;
export const pdfToolFile = "pdf_tool.py";
const openRouterUrl = "https://openrouter.ai/api/v1";

let source = null;
/** The tool's Python source, as the team plugin writes it. */
export const pdfToolSource = () =>
  (source ??= fs.readFileSync(
    fileURLToPath(new URL("./pdf-tool.py", import.meta.url)),
    "utf8",
  ));

// OpenClaw's limits for its extraction mode (docs/tools/pdf.md): 10 MB a PDF, 20
// pages, an image for a page under 200 characters of text, 4 megapixels shared.
const limits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 20,
  imageText: 200,
  pixelBudget: 4_000_000,
  // At most 200 dpi a page.
  maxScale: 200 / 72,
  timeoutS: 180,
});

const tool = Object.freeze({
  name: "pdf",
  description:
    "Read one or more PDF files from your workspace: their text and, for scanned pages or pages that are mostly images, the page images. Give pdf (one path) or pdfs (up to 10 paths), relative to your workspace or absolute inside it; no web addresses. prompt: what you want to know (default: analyze the document). pages: page numbers like 1-5 or 1,3,7-9 (at most 20 pages a PDF). password: for an encrypted PDF. Prefer this tool over read_file for PDFs.",
  parameters: {
    type: "object",
    properties: {
      pdf: { type: "string", minLength: 1, maxLength: 4096 },
      pdfs: {
        type: "array",
        minItems: 1,
        maxItems: pdfLimit,
        items: { type: "string", minLength: 1, maxLength: 4096 },
      },
      prompt: { type: "string", maxLength: 8000 },
      pages: { type: "string", maxLength: 200 },
      password: { type: "string", maxLength: 1000 },
    },
    additionalProperties: false,
  },
});

// The header an endpoint takes its key in instead of `Authorization: Bearer`
// (assistant-provider-endpoint.js `authHeader`, as model.js keyHeaders reads it).
function keyHeader(provider) {
  const headers = provider.authHeader === false && provider.headers;
  if (!headers) return null;
  return Object.keys(headers).find((key) => key !== "authorization") || null;
}

/**
 * How the tool reaches the fallback: `{ fallback, env }`, or null when Hermes cannot
 * (a transport other than Chat Completions, a login AgentPier does not hold). `pdf`:
 * the fallback connection as an apply resolves it (`{ provider }` of a model lease or
 * `{ chatgpt }`, and `images`: whether it takes images).
 */
function fallbackOf(pdf, modelProxy) {
  if (pdf?.chatgpt) {
    const { profileId, modelId, holder } = pdf.chatgpt;
    const credential = modelProxy?.credentialFor?.(profileId);
    if (holder !== "agentpier" || !modelProxy?.url || !credential) return null;
    return {
      fallback: {
        api: "codex",
        url: `${modelProxy.url}/chatgpt/codex`,
        model: modelId,
        label: modelId,
        // OpenAI's ChatGPT models see images.
        images: true,
      },
      env: { [pdfKeyEnv]: credential },
    };
  }
  const provider = pdf?.provider;
  const [model] = provider?.models || [];
  if (provider?.api !== "openai-completions" || !model?.id) return null;
  const header = provider.baseUrl === openRouterUrl ? null : keyHeader(provider);
  return {
    fallback: {
      api: "chat",
      url: provider.baseUrl,
      model: model.id,
      label: model.id,
      images: pdf.images === true,
      ...(header && { keyHeader: header }),
    },
    env: provider.apiKey ? { [pdfKeyEnv]: provider.apiKey } : {},
  };
}

/**
 * The pdf tool of `agent` (a desiredAgent): `{ settings, env }`, the tool's entry of
 * the team plugin's tools.json and the .env secret, or null when it gets none: it
 * may not read PDFs, or has no team plugin (`guarded`) or folder (`workspace`).
 * `model`: its compiled model section (model.js), whose `images` keeps the fallback
 * out; `pdf`: the fallback connection (fallbackOf), null without one.
 */
export function pdfHome(agent, { model, pdf, modelProxy, workspace, guarded }) {
  if (!agent.web.readPdfs || !guarded || !workspace) return null;
  const reach = model?.images ? null : fallbackOf(pdf, modelProxy);
  return {
    settings: {
      ...tool,
      folder: workspace,
      ...limits,
      ...(reach && { fallback: reach.fallback }),
    },
    env: reach?.env || {},
  };
}
