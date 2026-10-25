import React, { useState } from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import { CLEANUP_API, useCleanup } from "./useCleanup.jsx";
import { statusBytes } from "./system-status-format.js";

const AGES = [30, 90, 180];

/** Per CLI profile: transcripts of ended sessions older than the chosen age. */
export default function CleanupTranscripts() {
  const text = copy.cleanup.transcripts;
  const [days, setDays] = useState(90);
  const { data, confirm, feedback } = useCleanup("transcripts");
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  return (
    <>
      {feedback}
      {data && !profiles.length && <p className="hint">{text.empty}</p>}
      {profiles.length > 0 && (
        <>
          <Segmented
            label={text.age}
            value={days}
            onChange={setDays}
            options={AGES.map((value) => ({ value, label: text.days(value) }))}
          />
          <ListCard label={text.label}>
            {profiles.map((profile) => {
              const cutoff = profile.cutoffs?.find((item) => item.days === days) || {};
              const count = cutoff.count || 0;
              const size = statusBytes(cutoff.bytes || 0);
              const tool = copy.sessionTool[profile.tool] || profile.tool;
              const name = profile.name || tool;
              const details = [tool, count ? text.summary(count, size) : text.none];
              if (cutoff.kept) details.push(text.kept(cutoff.kept));
              return (
                <ListRow
                  key={profile.id}
                  label={name}
                  sub={details.join(" · ")}
                  value={count ? size : undefined}
                  disabled={!count}
                  deleteLabel={text.deleteLabel(name)}
                  onDelete={() =>
                    confirm({
                      title: text.confirmTitle(name, days),
                      body: [
                        text.confirmBody(count, size, days),
                        text.confirmWarning,
                        ...(profile.tool === "codex" ? [text.codexNote] : []),
                      ],
                      confirmLabel: text.confirm,
                      path: `${CLEANUP_API}/transcripts/${encodeURIComponent(profile.id)}`,
                      method: "POST",
                      payload: { olderThanDays: days },
                    })
                  }
                />
              );
            })}
          </ListCard>
        </>
      )}
    </>
  );
}
