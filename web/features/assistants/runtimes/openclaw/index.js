import MemoryWikiSurface from "./MemoryWikiSurface.jsx";
import ModelOptionsSurface from "./ModelOptionsSurface.jsx";
import WikiPage from "./WikiPage.jsx";
import { openClawSearch } from "./search.js";

/**
 * OpenClaw's web descriptor (docs/adr/0007-runtime-descriptor.md): the components of
 * its built surfaces by the surface id its server descriptor states (server
 * runtimes/openclaw/descriptor.js) and its search entries (search.js).
 */
export default Object.freeze({
  id: openClawSearch.id,
  surfaces: Object.freeze({
    memoryWiki: MemoryWikiSurface,
    modelOptions: ModelOptionsSurface,
    wiki: WikiPage,
  }),
  search: openClawSearch.entries,
});
