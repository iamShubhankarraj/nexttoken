import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { VoicePill } from "./components/VoicePill";
import "./index.css";

// The floating voice overlay window loads the same renderer with
// #voice-pill — it renders only the pill, over a transparent background.
const isVoicePill = window.location.hash === "#voice-pill";
if (isVoicePill) {
  // The shared stylesheet paints an opaque body background for the main
  // window; the frameless pill window must stay transparent so an idle
  // (nothing-rendered) pill is invisible instead of a blank box.
  document.body.classList.add("voice-pill-window");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isVoicePill ? <VoicePill /> : <App />}</React.StrictMode>,
);
