import type { Metadata } from "next";
import { Button } from "@/components/Button";
import { Container } from "@/components/Container";
import { CtaBand } from "@/components/CtaBand";
import { PhotoFrame } from "@/components/PhotoFrame";
import { Section, SectionHeading } from "@/components/Section";
import { cruiseLines, services } from "@/content/cruise-lines";
import { destinations } from "@/content/destinations";

export const metadata: Metadata = {
  title: "Cruises & Destinations",
  description:
    "Margaritaville at Sea specialists who also book Royal Caribbean, Carnival, Norwegian, Princess, Celebrity and more, plus all inclusive resorts, Alaska, Europe and group travel.",
  alternates: { canonical: "/cruises" },
};

export default function CruisesPage() {
  const featured = destinations.find(
    (item) => item.slug === "margaritaville-at-sea",
  );
  const rest = destinations.filter(
    (item) => item.slug !== "margaritaville-at-sea",
  );

  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-reef absolute inset-0 opacity-85"
        />
        <Container className="relative z-10 py-20 sm:py-24">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            Cruises and destinations
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            One specialty, and everywhere else too
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            Margaritaville at Sea is what we know best. It is not all we book.
            Every major cruise line, all inclusive resorts, land packages and
            group travel run through the same process and the same person.
          </p>
        </Container>
      </section>

      {/* Pinned specialty */}
      {featured ? (
        <Section spacing="loose" id={featured.slug}>
          <div className="overflow-hidden rounded-3xl border border-navy-100 bg-white">
            <div className="grid lg:grid-cols-2">
              <PhotoFrame
                tone={featured.tone}
                ratio="aspect-[4/3] lg:aspect-auto lg:h-full"
                rounded="rounded-none"
                label="Margaritaville at Sea"
              />
              <div className="p-8 sm:p-12">
                <p className="inline-flex items-center gap-2 rounded-full bg-coral-50 px-3 py-1 text-[0.7rem] font-semibold tracking-[0.16em] text-coral-600 uppercase">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-coral-400"
                  />
                  {featured.kicker}
                </p>
                <h2 className="mt-4 text-3xl font-semibold sm:text-4xl">
                  {featured.name}
                </h2>
                <p className="mt-5 text-lg leading-relaxed text-ink-700">
                  {featured.blurb}
                </p>
                <ul className="mt-7 space-y-2.5">
                  {featured.highlights.map((highlight) => (
                    <li key={highlight} className="flex gap-3 text-ink-700">
                      <span
                        aria-hidden="true"
                        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-navy-300"
                      />
                      {highlight}
                    </li>
                  ))}
                </ul>
                <div className="mt-9 flex flex-wrap gap-3">
                  <Button href="/quote" size="lg">
                    Get a Margaritaville quote
                  </Button>
                  <Button href="/book" variant="ghost" size="lg">
                    Ask a question first
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Section>
      ) : null}

      {/* Other destinations */}
      <section className="border-y border-navy-100 bg-sand-50">
        <Container className="py-20 sm:py-24">
          <SectionHeading
            eyebrow="Destinations"
            title="Where else people ask us to take them"
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((destination) => (
              <article
                key={destination.slug}
                id={destination.slug}
                className="flex flex-col overflow-hidden rounded-2xl border border-navy-100 bg-white scroll-mt-32"
              >
                <PhotoFrame
                  tone={destination.tone}
                  ratio="aspect-[16/10]"
                  rounded="rounded-none"
                />
                <div className="flex flex-1 flex-col p-6">
                  <p className="text-[0.7rem] font-semibold tracking-[0.16em] text-coral-500 uppercase">
                    {destination.kicker}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold">
                    {destination.name}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-ink-700">
                    {destination.blurb}
                  </p>
                  <ul className="mt-5 flex flex-1 flex-wrap gap-2 content-start">
                    {destination.highlights.map((highlight) => (
                      <li
                        key={highlight}
                        className="rounded-full bg-navy-50 px-2.5 py-1 text-xs text-navy-700"
                      >
                        {highlight}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            ))}
          </div>
        </Container>
      </section>

      {/* Cruise lines */}
      <Section spacing="loose">
        <SectionHeading
          eyebrow="Cruise lines"
          title="Lines we book, and what each one is good at"
          intro="Choosing a line matters more than most people expect. Here is the honest short version."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {cruiseLines.map((line) => (
            <div
              key={line.name}
              className={`rounded-2xl border p-6 ${
                line.featured
                  ? "border-coral-200 bg-coral-50"
                  : "border-navy-100 bg-white"
              }`}
            >
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-lg font-semibold">{line.name}</h3>
                {line.featured ? (
                  <span className="shrink-0 rounded-full bg-coral-400 px-2.5 py-1 text-[0.65rem] font-semibold tracking-wide text-white uppercase">
                    Specialty
                  </span>
                ) : null}
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-700">
                {line.note}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-sm text-ink-500">
          Do not see the line or destination you had in mind? Ask anyway. This
          list is what comes up most, not what we are limited to.
        </p>
      </Section>

      {/* Services */}
      <section className="border-t border-navy-100 bg-white">
        <Container className="py-20 sm:py-24">
          <SectionHeading
            eyebrow="Beyond cruising"
            title="Everything else we plan"
            align="center"
          />
          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => (
              <div key={service.title}>
                <div
                  aria-hidden="true"
                  className="h-1 w-10 rounded-full bg-coral-400"
                />
                <h3 className="mt-5 text-lg font-semibold">{service.title}</h3>
                <p className="mt-2.5 leading-relaxed text-ink-700">
                  {service.body}
                </p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CtaBand
        title="Have a destination in mind already?"
        body="Send it over with rough dates and party size. You will get real options back, not a wall of search results."
      />
    </>
  );
}
