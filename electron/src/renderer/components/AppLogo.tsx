/**
 * AppLogo — the Next Token brand mark (3D black-and-white overlapping
 * squares, abstract N in the negative space). Served from the bundled
 * renderer public dir so it works offline in the packaged app.
 */
export function AppLogo({
  size = 32,
  rounded = true,
  className = "",
  alt = "Next Token",
}: {
  size?: number;
  rounded?: boolean;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src="/nt-logo.png"
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      className={className}
      style={
        rounded
          ? { width: size, height: size, borderRadius: Math.max(6, Math.round(size * 0.22)) }
          : { width: size, height: size }
      }
    />
  );
}
