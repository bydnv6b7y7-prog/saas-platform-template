export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={`shrink-0 select-none text-brand ${className ?? ""}`}
    >
      <g fill="currentColor">
        <rect x="6" y="43" width="10" height="10" rx="2.5" />
        <rect x="25" y="27" width="14" height="14" rx="3.5" />
        <rect x="44" y="8" width="16" height="16" rx="4" />
      </g>
    </svg>
  );
}
