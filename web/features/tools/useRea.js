import useManagedTool from "./useManagedTool.js";

export { pushedLater } from "./useManagedTool.js";

/** The managed REA tool (`/api/rea`, topic `job.rea:current`); see useManagedTool. */
export default function useRea({ request }) {
  return useManagedTool({ request, tool: "rea" });
}
