import InstallSurface from "./InstallSurface.jsx";
import MixtureSurface from "./MixtureSurface.jsx";
import { hermesSearch } from "./search.js";
import { incompleteAdvisors } from "./mixture-rules.js";
import { assistantMixtureCopy } from "../../../../lib/i18n/messages/assistant-mixture.js";

/**
 * Hermes Agent's web descriptor (docs/adr/0007-runtime-descriptor.md): the components
 * of its built surfaces by the surface id its server descriptor states
 * (server runtimes/hermes/descriptor.js), its search entries (search.js), and why its
 * options in an agent's draft cannot be saved yet (`optionsProblem`), or null.
 */
export default Object.freeze({
  id: hermesSearch.id,
  surfaces: Object.freeze({ install: InstallSurface, mixture: MixtureSurface }),
  search: hermesSearch.entries,
  optionsProblem: (options) =>
    incompleteAdvisors(options) ? assistantMixtureCopy.incompleteSave : null,
});
