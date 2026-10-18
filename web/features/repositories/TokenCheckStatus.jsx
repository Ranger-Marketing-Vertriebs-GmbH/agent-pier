import { tokenCheckCopy as copy } from "../../lib/i18n/messages/repositories.js";
import StatusDot from "../../components/StatusDot.jsx";
import { formatTimestamp, locale } from "../../lib/i18n/index.js";
import React from "react";

const date = (value) =>
  new Date(value).toLocaleDateString(locale, { dateStyle: "medium" });
const tone = {
  valid: "ok",
  expiring: "warning",
  expired: "error",
  invalid: "error",
};

/** The last token check of one profile: what GitHub reported, never the token. */
export default function TokenCheckStatus({ check }) {
  if (!check) return <p className="token-check-detail">{copy.notChecked}</p>;
  const label = copy.states[check.state] || copy.states.error;
  const details = [
    check.login && copy.login(check.login),
    check.tokenType && copy.tokenTypes[check.tokenType],
    check.tokenType === "fine-grained"
      ? copy.fineGrainedPermissions
      : Array.isArray(check.scopes) &&
        (check.scopes.length ? copy.scopes(check.scopes.join(", ")) : copy.noScopes),
    check.state !== "error" &&
      check.state !== "invalid" &&
      (check.expiresAt ? copy.expires(date(check.expiresAt)) : copy.noExpiry),
    check.error && copy.errors[check.error],
  ].filter(Boolean);
  return (
    <div className="token-check" data-state={check.state}>
      <p className="token-check-state">
        <StatusDot tone={tone[check.state] || "error"} className="github-access-dot" />
        {label}
      </p>
      {details.map((detail) => (
        <p key={detail} className="token-check-detail">
          {detail}
        </p>
      ))}
      {(check.sso || []).map((item) => (
        <p key={item.organization} className="token-check-detail token-check-sso">
          {copy.ssoRequired(item.organization)}{" "}
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {copy.ssoAuthorize}
            </a>
          )}
        </p>
      ))}
      {check.checkedAt && (
        <p className="token-check-detail">
          {copy.checkedAt(formatTimestamp(check.checkedAt))}
        </p>
      )}
    </div>
  );
}
