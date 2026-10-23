/** The Tower Tracker glyph (same drawing as public/favicon.svg). */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="brand-mark">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="#22272b" stroke="#38414a" strokeWidth="1.5" />
      <rect x="6" y="7" width="5.5" height="18" rx="2" fill="#579dff" />
      <rect x="13.25" y="7" width="5.5" height="12" rx="2" fill="#4bce97" />
      <rect x="20.5" y="7" width="5.5" height="8" rx="2" fill="#f5cd47" />
    </svg>
  );
}
