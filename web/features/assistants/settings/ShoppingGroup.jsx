import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShoppingCopy as copy } from "../../../lib/i18n/messages/assistant-shopping.js";
import { shoppingBlocker } from "./shopping-switch.js";

const reasons = {
  archived: () => copy.archived,
  userAgent: () => copy.userAgent,
  browser: () => copy.needs(assistantCopy.personal.enableBrowser),
  memory: () => copy.needs(assistantCopy.personal.enableMemory),
  lead: () => copy.lead,
};

/**
 * The built-in Shopping skill's switch (docs/shopping.md): on by default for an agent
 * that may shop; otherwise off and disabled with the reason.
 */
export default function ShoppingGroup({ assistant, draft }) {
  const id = useId();
  const blocker = shoppingBlocker(assistant, draft.values);
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.hint}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy.title}
          sub={blocker ? reasons[blocker]() : copy.description}
          checked={!blocker && draft.values.shopping === true}
          disabled={Boolean(blocker)}
          onChange={(on) => draft.set("shopping", on)}
        />
      </ListCard>
    </section>
  );
}
