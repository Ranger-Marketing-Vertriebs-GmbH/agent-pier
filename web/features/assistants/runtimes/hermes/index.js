import InstallSurface from "./InstallSurface.jsx";
import { hermesSearch } from "./search.js";

/**
 * Hermes Agent's web descriptor (docs/adr/0007-runtime-descriptor.md): the components
 * of its built surfaces by the surface id its server descriptor states
 * (server runtimes/hermes/descriptor.js), and its search entries (search.js).
 */
export default Object.freeze({
  id: hermesSearch.id,
  surfaces: Object.freeze({ install: InstallSurface }),
  search: hermesSearch.entries,
});
