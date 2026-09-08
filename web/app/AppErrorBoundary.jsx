import React from "react";
import { appRecoveryCopy as copy } from "../lib/i18n/de/app.js";

export default class AppErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-recovery" role="alert">
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <button
          className="button primary"
          type="button"
          onClick={() => window.location.reload()}
        >
          {copy.reload}
        </button>
      </main>
    );
  }
}
