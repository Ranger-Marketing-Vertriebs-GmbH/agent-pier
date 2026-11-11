import {
  credentialListCopy,
  tokenCheckCopy as copy,
} from "../../lib/i18n/messages/repositories.js";
import StatusDot from "../../components/StatusDot.jsx";
import LearnMore from "../../components/LearnMore.jsx";
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

/**
 * The token of one profile: one status line (the last check's state, or whether a
 * token is saved), its details on one line and a classic token's scopes folded
 * behind their count. Shows what GitHub reported, never the token.
 */
export default function TokenCheckStatus({ hasSecret, check, children }) {
  const state = !hasSecret
    ? { tone: "idle", label: credentialListCopy.tokenMissing }
    : check
      ? { tone: tone[check.state] || "error", label: copy.states[check.state] }
      : { tone: "ok", label: credentialListCopy.tokenSaved };
  const details = check
    ? [
        check.login && copy.login(check.login),
        check.tokenType && copy.tokenTypes[check.tokenType],
        check.state !== "error" &&
          check.state !== "invalid" &&
          (check.expiresAt ? copy.expires(date(check.expiresAt)) : copy.noExpiry),
      ].filter(Boolean)
    : [];
  const scopes = check?.tokenType !== "fine-grained" && check?.scopes;
  return (
    <div className="token-check" data-state={check?.state}>
      <p className="token-check-state">
        <StatusDot tone={state.tone} className="github-access-dot" />
        {state.label || copy.states.error}
      </p>
      {hasSecret && !check && <p className="token-check-detail">{copy.notChecked}</p>}
      {details.length > 0 && <p className="token-check-detail">{details.join(" · ")}</p>}
      {check?.tokenType === "fine-grained" && (
        <p className="token-check-detail">{copy.fineGrainedPermissions}</p>
      )}
      {Array.isArray(scopes) &&
        (scopes.length ? (
          <div className="token-check-scopes">
            <LearnMore label={copy.scopes(scopes.length)}>
              <p className="token-check-scope-list">{scopes.join(", ")}</p>
            </LearnMore>
          </div>
        ) : (
          <p className="token-check-detail">{copy.noScopes}</p>
        ))}
      {check?.error && <p className="token-check-detail">{copy.errors[check.error]}</p>}
      {(check?.sso || []).map((item) => (
        <p key={item.organization} className="token-check-detail token-check-sso">
          {copy.ssoRequired(item.organization)}{" "}
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {copy.ssoAuthorize}
            </a>
          )}
        </p>
      ))}
      {children}
      {check?.checkedAt && (
        <p className="token-check-detail token-check-time">
          {copy.checkedAt(formatTimestamp(check.checkedAt))}
        </p>
      )}
    </div>
  );
}
