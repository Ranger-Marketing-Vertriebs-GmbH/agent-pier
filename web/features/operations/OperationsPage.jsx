import NotificationsPage from "../notifications/NotificationsPage.jsx";
import BackupsPage from "./BackupsPage.jsx";
import DiagnosticsPage from "./DiagnosticsPage.jsx";
import UpdatesPage from "./UpdatesPage.jsx";
import React from "react";
import AuditPage from "./AuditPage.jsx";
export default function OperationsPage({ section, ...props }) {
  return section === "audit" ? (
    <AuditPage {...props} />
  ) : section === "diagnostics" ? (
    <DiagnosticsPage {...props} />
  ) : section === "backups" ? (
    <BackupsPage {...props} />
  ) : section === "updates" ? (
    <UpdatesPage {...props} />
  ) : section === "notifications" ? (
    <NotificationsPage />
  ) : null;
}
