import type { ReactNode } from "react";
import { Container } from "./Container";

type SectionProps = {
  children: ReactNode;
  className?: string;
  id?: string;
  width?: "default" | "narrow" | "wide";
  /** Vertical rhythm. "tight" for stacked bands, "loose" for feature sections. */
  spacing?: "tight" | "default" | "loose";
};

export function Section({
  children,
  className = "",
  id,
  width = "default",
  spacing = "default",
}: SectionProps) {
  const pad =
    spacing === "tight"
      ? "py-12 sm:py-16"
      : spacing === "loose"
        ? "py-20 sm:py-28"
        : "py-16 sm:py-24";

  return (
    <section id={id} className={`${pad} ${className}`}>
      <Container width={width}>{children}</Container>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  intro,
  align = "left",
  tone = "dark",
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  align?: "left" | "center";
  tone?: "dark" | "light";
}) {
  const alignment = align === "center" ? "text-center mx-auto" : "";
  const titleColor = tone === "light" ? "text-white" : "";
  const introColor = tone === "light" ? "text-navy-100" : "text-ink-700";
  const eyebrowColor = tone === "light" ? "text-coral-300" : "text-coral-500";

  return (
    <div className={`max-w-2xl ${alignment}`}>
      {eyebrow ? (
        <p
          className={`mb-3 text-xs font-semibold uppercase tracking-[0.2em] ${eyebrowColor}`}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        className={`text-balance text-3xl leading-tight font-semibold sm:text-4xl ${titleColor}`}
      >
        {title}
      </h2>
      {intro ? (
        <p className={`mt-4 text-lg leading-relaxed ${introColor}`}>{intro}</p>
      ) : null}
    </div>
  );
}
