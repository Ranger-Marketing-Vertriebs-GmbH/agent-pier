import React, { useId } from "react";
import AddPicker from "../../../../components/AddPicker.jsx";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../../components/ListRow.jsx";
import ReferenceRow from "../../../../components/ReferenceRow.jsx";
import { routePath } from "../../../../app/routes.js";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { firstEntries } from "./access-groups.js";

const copy = assistantSettingsCopy.access;

/**
 * One group of the Access tab (handoff 5.4, 5.5): its granted entries (the first few,
 * then "n weitere · Alle anzeigen" opening the full subpage or the whole list), an
 * inline add field as the card's last row, and a "… einrichten" link to Zugänge while
 * the source has nothing to add. `rows` renders each granted entry; `total` is the
 * size of the source (null while it is unknown or unreadable).
 */
export default function AccessGroup({
  id: anchor,
  title,
  hint,
  entries,
  total,
  renderRow,
  more,
  picker,
  setup,
  loading = false,
  children,
  notes,
}) {
  const id = useId();
  const { shown, more: hidden } = more?.expanded
    ? { shown: entries, more: 0 }
    : firstEntries(entries);
  const label =
    total === null || total === undefined
      ? copy.count(title, entries.length)
      : copy.countOf(title, entries.length, total);
  return (
    <section id={anchor} aria-labelledby={id}>
      <GroupLabel id={id} hint={hint}>
        {label}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {loading && <ListRow label={title} value={unknownValue} />}
        {shown.map(renderRow)}
        {hidden > 0 && (
          <ListRow
            label={copy.more(hidden)}
            value={copy.showAll}
            {...(more.route
              ? { href: routePath(more.route), onClick: more.open }
              : { onClick: more.open })}
          />
        )}
        {picker && total > 0 && <AddPicker {...picker} />}
        {!loading && !entries.length && !(picker && total > 0) && (
          <ListRow label={copy.empty} />
        )}
      </ListCard>
      {children}
      {setup && (setup.always || total === 0) && (
        <ReferenceRow
          title={setup.title}
          href={routePath(setup.route)}
          onOpen={() => setup.navigate(setup.route)}
        />
      )}
      {notes}
    </section>
  );
}
