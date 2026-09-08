import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { messageLogCopy as copy } from "../../lib/i18n/de/agentbus.js";
import React from "react";
import { Pagination } from "../../components/Pagination.jsx";
import useAgentBusMessages from "./useAgentBusMessages.js";
export default function MessageLog({ request, project, page, onPage }) {
  const { error, setReload, data, paging } = useAgentBusMessages({
    request,
    project,
    page,
    onPage,
  });
  return (
    <section className="extension-section" aria-label={copy.extensionSectionAriaLabel}>
      <p className="field-description">{copy.inboxReadOnlyDescription}</p>
      {error && (
        <div className="extension-load-error">
          <ErrorMessage error={error} as="p" />
          <button className="button secondary" onClick={() => setReload((n) => n + 1)}>
            {copy.retryMessages}
          </button>
        </div>
      )}
      {!data && !error ? (
        <p className="loading" role="status">
          {copy.messagesLoading}
        </p>
      ) : (
        data && (
          <>
            <div className="section-heading">
              <h2>
                {copy.sectionHeadingHeading}
                {project.name}
              </h2>
              <span>
                {data.total}
                {copy.sectionHeadingLabel}
              </span>
            </div>
            {data.note && <p className="field-description">{data.note}</p>}
            <div className="agentbus-message-list">
              {data.items.length ? (
                data.items.map((message) => (
                  <article className="agentbus-message" key={message.id}>
                    <header>
                      <div>
                        <strong>
                          {message.from.name || message.from.tool || commonCopy.unknown}
                        </strong>
                        <span aria-label={copy.agentbusMessageAriaLabel}> → </span>
                        <strong>
                          {message.to.name || message.to.tool || commonCopy.unknown}
                        </strong>
                      </div>
                      <span className="agentbus-message-state">
                        {message.status === "pending"
                          ? commonCopy.inInbox
                          : commonCopy.retrieved}
                      </span>
                    </header>
                    <p className="agentbus-message-time">
                      <time dateTime={message.createdAt}>
                        {formatTimestamp(message.createdAt)}
                      </time>{" "}
                      · {message.from.tool} → {message.to.tool}
                    </p>
                    <div className="agentbus-message-text">{message.text}</div>
                  </article>
                ))
              ) : (
                <p className="extension-empty">{copy.extensionEmpty}</p>
              )}
            </div>
            <Pagination paging={paging} label={copy.extensionSectionAriaLabel} />
          </>
        )
      )}
    </section>
  );
}
