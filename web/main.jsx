import { initializeLanguage } from "./lib/i18n/index.js";
import LoginGate from "./features/login/LoginGate.jsx";
import "./styles/index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import AppErrorBoundary from "./app/AppErrorBoundary.jsx";
import { registerPublicWorker } from "./features/notifications/register-worker.js";
import { captureInstallPrompt } from "./features/notifications/install-prompt.js";
initializeLanguage();
captureInstallPrompt();
registerPublicWorker();
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <LoginGate>
        <App />
      </LoginGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);
