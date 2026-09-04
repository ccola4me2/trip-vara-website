import { Button } from "@/components/Button";
import { Section } from "@/components/Section";

export default function NotFound() {
  return (
    <Section spacing="loose" width="narrow" className="text-center">
      <p className="text-xs font-semibold tracking-[0.2em] text-coral-500 uppercase">
        Off the map
      </p>
      <h1 className="mt-4 text-4xl font-semibold sm:text-5xl">
        We could not find that page
      </h1>
      <p className="mt-5 text-lg leading-relaxed text-ink-700">
        The link may be out of date. Head back to the start, or tell us where
        you want to go and we will take it from there.
      </p>
      <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button href="/" size="lg">
          Back to home
        </Button>
        <Button href="/quote" variant="ghost" size="lg">
          Get a free quote
        </Button>
      </div>
    </Section>
  );
}
