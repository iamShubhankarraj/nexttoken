/**
 * AppLogo — the Next Token brand mark (3D black-and-white overlapping
 * squares, abstract N in the negative space). Imported through Vite so the
 * file is hashed into the bundle and resolves under both the dev server
 * and the packaged file:// renderer (an absolute "/nt-logo.png" breaks
 * under file://).
 */
import logoUrl from "../assets/nt-logo.png";

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
      src={logoUrl}
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
