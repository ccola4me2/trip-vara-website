import { Button } from "./Button";
import { Container } from "./Container";

export function CtaBand({
  eyebrow = "Ready when you are",
  title = "Tell us where you want to go",
  body = "Send a few details and you will get a personal, no obligation quote. No hold music, no call centre, no pressure.",
  primaryLabel = "Get a free quote",
  primaryHref = "/quote",
  secondaryLabel = "Book a discovery call",
  secondaryHref = "/book",
}: {
  eyebrow?: string;
  title?: string;
  body?: string;
  primaryLabel?: string;
  primaryHref?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}) {
  return (
    <section className="relative isolate overflow-hidden bg-navy-900">
      <div
        aria-hidden="true"
        className="photo-grain photo-sunset absolute inset-0 opacity-45"
      />
      <Container className="relative z-10 py-20 text-center sm:py-24">
        <p className="text-xs font-semibold tracking-[0.2em] text-coral-300 uppercase">
          {eyebrow}
        </p>
        <h2 className="mx-auto mt-4 max-w-2xl text-balance text-3xl leading-tight font-semibold text-white sm:text-4xl">
          {title}
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-navy-100">
          {body}
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href={primaryHref} size="lg">
            {primaryLabel}
          </Button>
          <Button href={secondaryHref} variant="onDark" size="lg">
            {secondaryLabel}
          </Button>
        </div>
      </Container>
    </section>
  );
}
