import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";

// Sample data for the gallery: everything is local, nothing reaches the API.
export const noop = () => {};

export const options = () => [
  { value: "a", label: copy.sample.optionA },
  { value: "b", label: copy.sample.optionB },
  { value: "c", label: copy.sample.optionC },
  { value: "x", label: copy.sample.optionDisabled, disabled: true },
];

export const pageItems = () =>
  Array.from({ length: 45 }, (_, index) => copy.sample.pageItem(index + 1));

export const detailItems = () => [
  { id: "a", name: copy.sample.optionA },
  { id: "b", name: copy.sample.optionB },
  { id: "c", name: copy.sample.optionC },
];

// A small inline SVG; colours as rgb() since only base.css holds hex literals.
export const sampleImage =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200' viewBox='0 0 320 200'>" +
      "<rect width='320' height='200' fill='rgb(24,25,29)'/>" +
      "<circle cx='160' cy='100' r='56' fill='rgb(244,154,88)'/></svg>",
  );

/** A settings draft (useTabDraft) frozen in one of the save bar's states. */
export function sampleDraft(state) {
  const outcome =
    state === "error"
      ? { status: "error", error: { message: copy.sample.error } }
      : state === "conflict"
        ? { status: "conflict" }
        : state === "partial"
          ? { status: "error", partial: [copy.sample.optionA] }
          : null;
  return {
    dirty: state !== "hidden",
    saving: state === "saving",
    outcome,
    conflicts: [],
    reset: noop,
    reload: noop,
  };
}

/** 600 synthetic SSH accesses for AddPicker: prod/stage/dev × web/db/api/logs × 50. */
export function sshHosts() {
  const projects = { prod: copy.addPicker.global, stage: "api-server", dev: "shop" };
  return Object.entries(projects).flatMap(([env, project], envIndex) =>
    ["web", "db", "api", "logs"].flatMap((role, roleIndex) =>
      Array.from({ length: 50 }, (_, index) => {
        const name = `${env}-${role}-${String(index + 1).padStart(2, "0")}`;
        return {
          id: name,
          name,
          sub: `deploy@10.${envIndex}.${roleIndex}.${index + 1}`,
          group: project,
        };
      }),
    ),
  );
}

/** MCP servers for the AddPicker search sample. */
export const mcpServers = () =>
  [
    "github",
    "filesystem",
    "fetch",
    "postgres",
    "sqlite",
    "slack",
    "sentry",
    "linear",
  ].map((name) => ({ id: name, name, sub: `@modelcontextprotocol/server-${name}` }));

/** An hour of sample load, one point a minute, with ten minutes nobody measured. */
export function historySample(end) {
  return Array.from({ length: 61 }, (_, index) => ({
    t: end - (60 - index) * 60_000,
    first: 20 + 10 * Math.sin(index / 5),
    second: 60 + 3 * Math.cos(index / 7),
    third: 5 + 2 * Math.sin(index / 3),
  })).filter((_, index) => index < 25 || index > 35);
}
