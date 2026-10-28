/** Marca del producto (la misma del inicio de sesión del panel local). Decorativa. */
export default function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="44" height="44" rx="6" stroke="#5fd1b8" strokeWidth="3" />
      <circle cx="28" cy="28" r="7" fill="#5fd1b8" />
      <path d="M28 35v9" stroke="#5fd1b8" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
