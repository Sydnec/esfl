/** Monogramme ESFL : carré arrondi accent, « E » géométrique. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="ESFL">
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <rect x="10" y="8" width="13" height="3.5" rx="1" fill="#ffffff" />
      <rect x="10" y="14.25" width="10" height="3.5" rx="1" fill="#ffffff" />
      <rect x="10" y="20.5" width="13" height="3.5" rx="1" fill="#ffffff" />
      <rect x="8" y="8" width="3.5" height="16" rx="1" fill="#ffffff" />
    </svg>
  );
}
