import React, { useId } from "react";
import Icon from "./Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "./InfoHint.jsx";
import { isPlainClick } from "./link-click.js";
import { commonCopy } from "../lib/i18n/messages/common.js";

// Shown until a value is known; rows never show a made-up 0.
export const unknownValue = "—";

function RowText({ label, sub, labelId, subId }) {
  return (
    <span className="list-row-text">
      <span className="list-row-label" id={labelId}>
        {label}
      </span>
      {sub && (
        <span className="list-row-sub" id={subId}>
          {sub}
        </span>
      )}
    </span>
  );
}

function Trailing({ value, status }) {
  if (status)
    return (
      <span className={`list-row-status ${status.tone}`}>
        {status.tone !== "warn" && <span className="dot" aria-hidden="true" />}
        {status.text}
      </span>
    );
  if (value === undefined || value === null || value === false) return null;
  return <span className="list-row-value">{value}</span>;
}

const rowClass = (sub, ...extra) =>
  ["list-row", sub ? "two-line" : "", ...extra].filter(Boolean).join(" ");

export default function ListRow({
  label,
  sub,
  icon,
  value,
  status,
  onClick,
  href,
  target,
  chevron,
  menu,
  onDelete,
  deleteLabel,
  hint,
  hintLabel,
  disabled = false,
  current = false,
  className = "",
  children,
}) {
  const info = useInfoHint();
  const navigates = Boolean(onClick || href);
  // A row opening a new tab never hands that tab a reference back to AgentPier.
  const body = (
    <>
      {icon && (
        <span className="list-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <RowText label={label} sub={sub} />
      <Trailing value={value} status={status} />
      {(chevron ?? navigates) && (
        <Icon name="chevron" size={14} className="list-row-chevron" />
      )}
    </>
  );
  const main = href ? (
    <a
      className="list-row-main"
      href={href}
      target={target}
      rel={target ? "noopener noreferrer" : undefined}
      aria-disabled={disabled || undefined}
      aria-current={current === true ? "page" : current || undefined}
      onClick={(event) => {
        // A disabled link row never navigates, not even natively.
        if (disabled) return event.preventDefault();
        if (!onClick || !isPlainClick(event)) return;
        event.preventDefault();
        onClick();
      }}
    >
      {body}
    </a>
  ) : onClick ? (
    <button type="button" className="list-row-main" onClick={onClick} disabled={disabled}>
      {body}
    </button>
  ) : (
    <div className="list-row-main">{body}</div>
  );
  return (
    <>
      <div className={rowClass(sub, className)}>
        {main}
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {children}
        {menu && (
          <button
            type="button"
            className="list-row-icon-button"
            aria-label={menu.label ?? commonCopy.moreActions}
            aria-haspopup="menu"
            aria-expanded={menu.expanded}
            disabled={disabled}
            onClick={menu.onClick}
          >
            <Icon name="more" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="list-row-icon-button"
            aria-label={deleteLabel ?? commonCopy.delete}
            disabled={disabled}
            onClick={onDelete}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}

function ControlRow({
  kind,
  label,
  sub,
  hint,
  hintLabel,
  control,
  selected = false,
  describedBy,
}) {
  const info = useInfoHint();
  const id = useId();
  return (
    <>
      <div className={rowClass(sub, `${kind}-row`, selected ? "selected" : "")}>
        <label className="list-row-main" htmlFor={id}>
          <RowText label={label} sub={sub} labelId={`${id}-label`} subId={`${id}-sub`} />
        </label>
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {control({
          id,
          "aria-labelledby": `${id}-label`,
          "aria-describedby":
            [sub ? `${id}-sub` : "", describedBy].filter(Boolean).join(" ") || undefined,
        })}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}

export function ToggleRow({ checked, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="toggle"
      {...row}
      control={(props) => (
        <input
          {...props}
          type="checkbox"
          role="switch"
          className="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      )}
    />
  );
}

export function NumberRow({ value, onChange, min, max, step, disabled, ...row }) {
  return (
    <ControlRow
      kind="number"
      {...row}
      control={(props) => (
        <input
          {...props}
          type="number"
          inputMode="numeric"
          className="list-row-number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value === "" ? "" : Number(event.target.value))
          }
        />
      )}
    />
  );
}

export function SelectRow({ value, options, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="select"
      {...row}
      control={(props) => (
        <span className="list-row-select">
          <select
            {...props}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value} lang={option.lang}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon name="down" size={14} />
        </span>
      )}
    />
  );
}

export function RadioRow({ name, value, checked, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="radio"
      selected={checked}
      {...row}
      control={(props) => (
        <input
          {...props}
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onChange(value)}
        />
      )}
    />
  );
}

export function CheckboxRow({ checked, onChange, pill, disabled, ...row }) {
  return (
    <ControlRow
      kind="checkbox"
      {...row}
      control={(props) => (
        <>
          {pill && <span className="list-row-pill">{pill}</span>}
          <input
            {...props}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        </>
      )}
    />
  );
}
