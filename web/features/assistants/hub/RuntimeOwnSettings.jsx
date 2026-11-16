import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import {
  NumberRow,
  SelectRow,
  TextRow,
  ToggleRow,
} from "../../../components/ListRow.jsx";
import { formatNumber } from "../../../lib/i18n/index.js";
import { assistantAdvancedCopy as copy } from "../../../lib/i18n/messages/assistant-advanced.js";
import { ownRows } from "./advanced-scopes.js";

// How a change of a described field takes effect, in the words of the shared rows.
const applies = () => ({
  live: copy.live,
  nextTurn: copy.nextTurn,
  restart: copy.restart,
});

// A field's default in its own words: the option's label, the number with its unit.
function defaultText(field, text) {
  if (field.type === "toggle") return field.default ? copy.on : copy.off;
  if (field.type === "select") return text.options?.[field.default] ?? field.default;
  if (field.type === "number")
    return [formatNumber(field.default), text.unit].filter(Boolean).join(" ");
  return field.default || copy.emptyText;
}

function OwnRow({ field, text, value, onChange, disabled }) {
  const row = {
    label: text.unit ? `${text.label} (${text.unit})` : text.label,
    sub: [copy.defaultValue(defaultText(field, text)), applies()[field.apply]]
      .filter(Boolean)
      .join(" · "),
    hint: text.hint,
    hintLabel: text.label,
    disabled,
    onChange,
  };
  if (field.type === "toggle") return <ToggleRow {...row} checked={value === true} />;
  if (field.type === "select")
    return (
      <SelectRow
        {...row}
        value={value}
        options={field.options.map((option) => ({
          value: option,
          label: text.options?.[option] ?? option,
        }))}
      />
    );
  if (field.type === "number")
    return (
      <NumberRow
        {...row}
        value={value}
        min={field.min}
        max={field.max}
        step={field.step ?? "any"}
      />
    );
  return <TextRow {...row} value={value} maxLength={500} />;
}

/**
 * A runtime's own advanced settings (docs/adr/0007-runtime-descriptor.md): the fields
 * of one described surface at the slot `hub.runtime.advanced`, as rows under the
 * runtime's name. AgentPier renders them from the description; the texts are the
 * runtime's catalog namespace (`copy(fieldId)`), never the server's. `context` is the
 * Runtime tab's: the settings answer (`data`), the draft `values`, `edit(key)` and
 * `disabled`. A field without texts in this build, or without a value yet, is left
 * out; nothing renders without any.
 */
export default function RuntimeOwnSettings({ runtime, surface, context, copy: copyOf }) {
  const id = useId();
  const rows = ownRows(context.data, runtime, surface, copyOf);
  if (!rows.length) return null;
  return (
    <>
      <GroupLabel as="h3" id={id}>
        {runtime.name}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {rows.map(({ field, key, text }) => (
          <OwnRow
            key={key}
            field={field}
            text={text}
            value={context.values[key] ?? field.default}
            onChange={context.edit(key)}
            disabled={context.disabled}
          />
        ))}
      </ListCard>
    </>
  );
}
