import { lazy } from "react";

const ConnectionDetail = lazy(
  () => import("../provider-connections/ConnectionDetail.jsx"),
);
const NativeAccountDetail = lazy(() => import("./NativeAccountDetail.jsx"));
const ChatgptLoginDetail = lazy(() => import("../assistants/ChatgptLoginDetail.jsx"));
const ChatgptAccountDetail = lazy(() => import("../assistants/ChatgptAccountDetail.jsx"));
const SpeechSettings = lazy(() => import("../assistants/SpeechSettings.jsx"));
const WebSearchSettings = lazy(() => import("../assistants/WebSearchSettings.jsx"));
const PdfModelSettings = lazy(() => import("../assistants/PdfModelSettings.jsx"));
const McpServerEntry = lazy(() => import("../mcp-servers/McpServerEntry.jsx"));
const McpFindsDetail = lazy(() => import("../mcp-servers/McpFindsDetail.jsx"));

// Detail subpages by entry kind (see accounts-items.js). Each detail is loaded on
// demand, so agent modules and their requests stay out of /accounts while agents are
// off. Every component receives the DetailProps documented in AccountsPage.jsx.
export const detailComponents = {
  connection: ConnectionDetail,
  "connection-new": ConnectionDetail,
  "chatgpt-login": ChatgptLoginDetail,
  chatgpt: ChatgptAccountDetail,
  "cli-account": NativeAccountDetail,
  "cli-new": NativeAccountDetail,
  speech: SpeechSettings,
  "web-search": WebSearchSettings,
  "pdf-model": PdfModelSettings,
  "mcp-server": McpServerEntry,
  "mcp-new": McpServerEntry,
  "mcp-finds": McpFindsDetail,
};
