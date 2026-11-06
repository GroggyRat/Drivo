/** The Drivo mark (brand/drivo-mark.svg): a delivery route ending at a pin. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <rect width="512" height="512" rx="112" fill="#0B1F44"/> <g transform="translate(-6 -18) scale(1.04)"><path d="M124 390 H300 C334 390 352 372 352 338 V318" fill="none" stroke="#2563EB" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round"/><circle cx="124" cy="390" r="38" fill="#2563EB"/><circle cx="124" cy="390" r="15" fill="#0B1F44"/><path d="M352 282 C326 252 286 226 286 186 A66 66 0 0 1 418 186 C418 226 378 252 352 282 Z" fill="#fff"/><circle cx="352" cy="186" r="24" fill="#2563EB"/></g>
    </svg>
  );
}

/** Mark and name together. */
export function Logo({ size = 32, className = "", tone = "dark" }: { size?: number; className?: string; tone?: "dark" | "light" }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className={`font-semibold tracking-tight ${tone === "light" ? "text-white" : "text-navy"}`} style={{ fontSize: size * 0.62 }}>Drivo</span>
    </span>
  );
}
