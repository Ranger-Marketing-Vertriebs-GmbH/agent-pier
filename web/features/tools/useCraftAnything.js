import useManagedTool from "./useManagedTool.js";

/**
 * The managed Craft Anything tool (`/api/craft-anything`, topic
 * `job.craft-anything:current`); see useManagedTool.
 */
export default function useCraftAnything({ request }) {
  return useManagedTool({ request, tool: "craft-anything" });
}
