/**
 * Typings for Electron's <webview> tag. Tabs are real webview guests —
 * main attaches each guest's WebContents via nt.tabsAttach(tabId,
 * webContentsId) once the webview fires `dom-ready`.
 *
 * React 19 moved the JSX namespace under 'react/jsx-runtime', so the
 * intrinsic element is extended there.
 */

import type { CSSProperties, Ref } from "react";

export interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  getURL(): string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  stop(): void;
}

export interface WebviewNewWindowEvent extends Event {
  url: string;
}

interface WebviewTagProps {
  src?: string;
  partition?: string;
  allowpopups?: boolean | string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<WebviewElement | null>;
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewTagProps;
    }
  }
}

export {};
