import { legacyPage, splitPage } from "./history-page-split.js";
import { cliDriver } from "../clis/drivers.js";
import { isCodingCli } from "../clis/catalog.js";

/**
 * One page of a chat: the CLI's own page when its driver reads one, otherwise a
 * page over the remaining messages or over a full read.
 */
export async function readHistoryPage(history, session, id, state = null) {
  const page = isCodingCli(session.tool)
    ? await cliDriver(session.tool).history.readPage(history, session, id, state)
    : null;
  if (page) return page;
  if (state?.remaining?.length) return splitPage(state.remaining, state.continuation);
  return legacyPage(await history.read(session, id), state);
}
