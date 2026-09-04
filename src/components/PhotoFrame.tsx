import type { ReactNode } from "react";

export type PhotoTone =
  | "reef"
  | "sunset"
  | "harbor"
  | "dune"
  | "deep"
  | "palm";

/**
 * Stand-in for real photography.
 *
 * Renders a layered gradient with fine grain and an optional caption noting
 * what image belongs here, so the client can see exactly what to supply.
 * Replace with <Image src="..." fill className="object-cover" /> when the
 * real photo is available.
 */
export function PhotoFrame({
  tone = "reef",
  className = "",
  ratio = "aspect-[4/3]",
  label,
  children,
  rounded = "rounded-2xl",
}: {
  tone?: PhotoTone;
  className?: string;
  ratio?: string;
  /** Short note describing the intended photo. Hidden from screen readers. */
  label?: string;
  children?: ReactNode;
  rounded?: string;
}) {
  return (
    <div
      className={`photo-grain relative isolate overflow-hidden ${rounded} photo-${tone} ${ratio} ${className}`}
    >
      {children}
      {label ? (
        <span
          aria-hidden="true"
          className="absolute bottom-3 left-3 z-10 rounded-full bg-navy-950/45 px-3 py-1 text-[0.65rem] font-medium tracking-wide text-white/75 backdrop-blur-sm"
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
