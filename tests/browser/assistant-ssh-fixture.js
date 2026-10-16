import { baseURL } from "../helpers/browser.js";

// Shared SSH hosts, catalog and approval stand-ins for the agent SSH specs.
export const opnsense = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "opnsense",
  host: "opnsense.invalid",
  port: 22,
  username: "root",
  hostFingerprint: "SHA256:opnsense",
  projectId: null,
  projectName: null,
};
export const nas = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "nas-01",
  host: "nas.invalid",
  port: 2222,
  username: "admin",
  hostFingerprint: "SHA256:nas",
  projectId: "p1",
  projectName: "Homelab",
};
export const catalog = (sshHosts = [opnsense, nas]) => ({
  projects: [],
  pipelines: [],
  sshHosts,
});

export const sshAction = (id, extra = {}) => ({
  id,
  revision: 1,
  assistantId: "home",
  state: "awaiting_approval",
  createdAt: "2026-10-16T10:00:00.000Z",
  expiresAt: "2026-10-16T10:10:00.000Z",
  ...extra,
  payload: {
    action: "ssh",
    accessId: "11111111-1111-4111-8111-111111111111",
    hostName: "opnsense",
    host: "opnsense.invalid",
    port: 22,
    username: "root",
    hostFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
    projectId: null,
    projectName: null,
    command: "uptime",
    timeoutSeconds: 30,
    originClass: "owner",
    ...extra.payload,
  },
});
export const openChat = (page) => page.goto(baseURL + "/agents/home/chats/chat");
// The card is named by its title, which follows the UI language.
export const sshCard = (page, language = "en") =>
  page.getByRole("article", { name: language === "de" ? "SSH-Befehl" : "SSH command" });
