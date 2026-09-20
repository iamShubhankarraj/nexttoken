/**
 * Site favicon with a graceful fallback.
 *
 * Shows the page's real favicon (captured by main via page-favicon-updated
 * and cached per host) and falls back to the domain-matched Lucide glyph
 * when there is none or the image fails to decode. Purely presentational —
 * no network requests from here.
 */

import { useEffect, useState } from "react";
import { iconForUrl } from "../nt";

export function Favicon({
  url,
  favicon,
  size = 16,
}: {
  url: string;
  favicon?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [favicon, url]);

  if (favicon && !failed) {
    return (
      <img
        src={favicon}
        width={size}
        height={size}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="shrink-0"
        style={{ borderRadius: Math.max(2, Math.round(size / 5)) }}
      />
    );
  }
  const Icon = iconForUrl(url);
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      className="shrink-0"
      style={{ color: "var(--nt-text-3)" }}
    />
  );
}
