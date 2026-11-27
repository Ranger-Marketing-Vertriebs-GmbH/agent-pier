import MemoryWikiSurface from "./MemoryWikiSurface.jsx";
import ModelOptionsSurface from "./ModelOptionsSurface.jsx";
import WikiPage from "./WikiPage.jsx";
import { openClawSearch } from "./search.js";
import { fallbackSaveProblem } from "./fallback-rules.js";

/**
 * OpenClaw's web descriptor (docs/adr/0007-runtime-descriptor.md): the components of
 * its built surfaces by the surface id its server descriptor states (server
 * runtimes/openclaw/descriptor.js), its search entries (search.js), and why its
 * options in an agent's draft cannot be saved yet (`optionsProblem`), or null.
 */
export default Object.freeze({
  id: openClawSearch.id,
  surfaces: Object.freeze({
    memoryWiki: MemoryWikiSurface,
    modelOptions: ModelOptionsSurface,
    wiki: WikiPage,
  }),
  search: openClawSearch.entries,
  optionsProblem: fallbackSaveProblem,
});
