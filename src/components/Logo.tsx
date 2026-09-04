type MarkProps = {
  className?: string;
  /** "default" for light backgrounds, "inverse" for navy backgrounds. */
  variant?: "default" | "inverse";
};

/**
 * Trip Vara compass mark, rebuilt as inline SVG from the supplied logo art so
 * it stays crisp at any size and can be recoloured for dark surfaces.
 *
 * To use the original vector instead, drop it at public/logo-mark.svg and
 * swap this component for a next/image reference.
 */
export function LogoMark({ className, variant = "default" }: MarkProps) {
  const structure = variant === "inverse" ? "#ffffff" : "var(--color-navy-800)";
  const accent = "var(--color-coral-400)";

  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* Broken compass ring */}
      <path
        d="M69.45 23.08 A 42 42 0 1 0 95.23 41.13"
        fill="none"
        stroke={accent}
        strokeWidth="5.5"
        strokeLinecap="round"
      />

      {/* North needle */}
      <path d="M60 4 L65.5 30 L60 25.5 L54.5 30 Z" fill={structure} />

      {/* West and east compass points */}
      <path d="M2 64 L28 55.5 L23 64 L28 72.5 Z" fill={structure} />
      <path d="M118 64 L92 55.5 L97 64 L92 72.5 Z" fill={structure} />

      {/* T crossbar */}
      <path d="M10 30 L110 30 L100 45 L20 45 Z" fill={structure} />

      {/* T stem, tapering into the south needle */}
      <path d="M53 45 L67 45 L67 95 L60 115 L53 95 Z" fill={structure} />

      {/* Centre spark */}
      <path
        d="M60 49 Q62 58.5 72 62 Q62 65.5 60 75 Q58 65.5 48 62 Q58 58.5 60 49 Z"
        fill={accent}
      />
    </svg>
  );
}

type LockupProps = {
  className?: string;
  variant?: "default" | "inverse";
  /** Show the tagline beneath the wordmark. */
  withTagline?: boolean;
};

export function LogoLockup({
  className,
  variant = "default",
  withTagline = false,
}: LockupProps) {
  const word = variant === "inverse" ? "text-white" : "text-navy-800";

  return (
    <span className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark className="h-9 w-9 shrink-0" variant={variant} />
      <span className="flex flex-col leading-none">
        <span
          className={`font-display text-[1.05rem] font-semibold uppercase tracking-[0.28em] ${word}`}
        >
          Trip<span className="ml-[0.28em]">Vara</span>
        </span>
        {withTagline ? (
          <span className="mt-1.5 text-[0.6rem] tracking-[0.09em] text-coral-400">
            From first inquiry to welcome home.
          </span>
        ) : null}
      </span>
    </span>
  );
}
