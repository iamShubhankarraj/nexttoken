import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { VoicePill } from "./components/VoicePill";
import "./index.css";

// The floating voice overlay window loads the same renderer with
// #voice-pill — it renders only the pill, over a transparent background.
const isVoicePill = window.location.hash === "#voice-pill";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isVoicePill ? <VoicePill /> : <App />}</React.StrictMode>,
);
