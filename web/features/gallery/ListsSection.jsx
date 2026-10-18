import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import PermissionList from "../../components/PermissionList.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { noop } from "./gallery-fixtures.js";

export default function ListsSection() {
  const s = copy.sample;
  return (
    <GallerySection id="lists">
      <Specimen label="GroupLabel" wide>
        <GroupLabel
          as="h3"
          hint={s.hint}
          action={{ label: s.groupAction, onClick: noop }}
        >
          {s.label}
        </GroupLabel>
      </Specimen>
      <Specimen label="ListCard · ListRow" wide>
        <ListCard label={s.label}>
          <ListRow label={s.label} sub={s.sub} value={s.value} />
          <ListRow label={s.unknown} value={unknownValue} />
          <ListRow label={s.navigates} sub={s.sub} onClick={noop} />
          <ListRow label={s.current} onClick={noop} current />
          <ListRow label={s.statusOk} status={{ tone: "ok", text: s.statusOk }} />
          <ListRow label={s.statusWarn} status={{ tone: "warn", text: s.statusWarn }} />
          <ListRow
            label={s.statusError}
            status={{ tone: "error", text: s.statusError }}
          />
          <ListRow label={s.withMenu} menu={{ onClick: noop, expanded: false }} />
          <ListRow label={s.withDelete} onDelete={noop} />
          <ListRow label={s.withHint} hint={s.hint} />
          <ListRow label={s.disabled} onClick={noop} disabled />
        </ListCard>
      </Specimen>
      <Specimen label="ListCard disabled" wide>
        <ListCard label={s.disabledCard} disabled>
          <ListRow label={s.disabledCard} sub={s.sub} />
        </ListCard>
      </Specimen>
      <Specimen label="ReferenceRow" wide>
        <ReferenceRow title={s.reference} onOpen={noop} />
        <ReferenceRow
          title={s.reference}
          count={s.referenceCount}
          href="#"
          onOpen={noop}
        />
      </Specimen>
      <Specimen label="PermissionList" wide>
        <PermissionList
          label={s.permissions}
          items={[
            ["read", s.permissionRead],
            ["write", s.permissionWrite],
          ]}
        />
      </Specimen>
    </GallerySection>
  );
}
