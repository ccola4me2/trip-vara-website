import Link from "next/link";
import { Button } from "@/components/Button";
import { Container } from "@/components/Container";
import { CtaBand } from "@/components/CtaBand";
import { PhotoFrame } from "@/components/PhotoFrame";
import { Section, SectionHeading } from "@/components/Section";
import { TestimonialCard } from "@/components/TestimonialCard";
import { destinations } from "@/content/destinations";
import { testimonials } from "@/content/testimonials";
import { site } from "@/config/site";

const trustPoints = [
  {
    label: "Cruise Planners affiliated",
    detail: "Backed by one of the largest travel franchises in the country",
  },
  {
    label: "Margaritaville at Sea specialists",
    detail: "The line we sail, know and book more than any other",
  },
  {
    label: "You pay the same or less",
    detail: "Our planning costs you nothing extra versus booking direct",
  },
  {
    label: "One person, start to finish",
    detail: "The same advisor from first question to welcome home",
  },
];

const steps = [
  {
    number: "01",
    title: "Tell us the shape of the trip",
    body: "Who is going, roughly when, and what would make it feel worth it. No itinerary required, a rough idea is plenty.",
  },
  {
    number: "02",
    title: "Get real options, not a list of links",
    body: "You get a short set of recommendations with the trade offs spelled out, plus the perks and pricing we can access.",
  },
  {
    number: "03",
    title: "Travel with backup",
    body: "We handle the booking, the documents and the reminders. If something goes sideways on the road, you have a person to call.",
  },
];

export default function HomePage() {
  const featured = destinations.slice(0, 6);

  return (
    <>
      {/* Hero */}
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-deep absolute inset-0"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-r from-navy-950/85 via-navy-900/70 to-navy-900/30"
        />
        <Container className="relative z-10 py-20 sm:py-28 lg:py-32">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
                {site.tagline}
              </p>
              <h1 className="mt-5 text-balance text-4xl leading-[1.08] font-semibold text-white sm:text-5xl lg:text-6xl">
                Vacations planned by someone who actually answers the phone
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-navy-100">
                Trip Vara is {site.advisor.name}, an independent travel advisor
                affiliated with {site.advisor.affiliation}. Cruises, all
                inclusive resorts and group getaways, planned around what you
                actually want out of the week.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Button href="/quote" size="lg">
                  Get a free quote
                </Button>
                <Button href="/book" variant="onDark" size="lg">
                  Book a discovery call
                </Button>
              </div>
              <p className="mt-6 text-sm text-navy-200">
                No fees to plan. No obligation. Usually a reply within one
                business day.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <PhotoFrame
                tone="sunset"
                ratio="aspect-[3/4]"
                className="translate-y-4"
                label="Margaritaville at Sea"
              />
              <PhotoFrame
                tone="reef"
                ratio="aspect-[3/4]"
                className="-translate-y-4"
                label="Caribbean beach day"
              />
            </div>
          </div>
        </Container>
      </section>

      {/* Trust bar */}
      <section className="border-b border-navy-100 bg-white">
        <Container className="py-10">
          <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {trustPoints.map((point) => (
              <li key={point.label}>
                <p className="flex items-start gap-2 font-display text-sm font-semibold text-navy-800">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-coral-400"
                  />
                  {point.label}
                </p>
                <p className="mt-1.5 pl-3.5 text-sm leading-relaxed text-ink-500">
                  {point.detail}
                </p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* Intro to Brent */}
      <Section spacing="loose">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <PhotoFrame
            tone="harbor"
            ratio="aspect-[4/5]"
            className="max-w-md"
            label="Portrait of Brent"
          />
          <div>
            <SectionHeading
              eyebrow="Who you are working with"
              title="A travel advisor, not a booking engine"
              intro="Trip Vara grew out of years of planning cruises for friends, family and eventually a lot of strangers who heard we were good at it. The name changed from Parrot Heads Cruising. The approach did not."
            />
            <p className="mt-5 leading-relaxed text-ink-700">
              A booking site sells you a price. An advisor asks why you are
              going, then tells you which cabin is worth the upgrade, which port
              day to skip, and which sailing quietly costs less two weeks later.
              That is the difference, and it does not cost you more.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button href="/about" variant="ghost">
                Read Brent&apos;s story
              </Button>
              <Button href="/book" variant="secondary">
                Book a discovery call
              </Button>
            </div>
          </div>
        </div>
      </Section>

      {/* Margaritaville at Sea specialty */}
      <section className="relative isolate overflow-hidden bg-navy-800">
        <div
          aria-hidden="true"
          className="photo-grain photo-sunset absolute inset-0 opacity-60"
        />
        <Container className="relative z-10 py-20 sm:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr]">
            <div>
              <SectionHeading
                eyebrow="Our specialty"
                title="We know Margaritaville at Sea better than anyone else you will call"
                intro="Short sailings out of Florida with the island state of mind built in. It is the easiest cruise to say yes to, and the one where knowing the details pays off most."
                tone="light"
              />
              <ul className="mt-8 space-y-3 text-navy-100">
                {[
                  "Which cabin categories are genuinely worth the upgrade",
                  "How to time a booking around promotions instead of chasing them",
                  "Group space for milestone trips, reunions and friend groups",
                  "What to expect onboard, honestly, so nobody is surprised",
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-coral-400"
                    />
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-9 flex flex-wrap gap-3">
                <Button href="/quote" size="lg">
                  Get a Margaritaville quote
                </Button>
                <Button href="/cruises" variant="onDark" size="lg">
                  See all cruise lines
                </Button>
              </div>
            </div>
            <PhotoFrame
              tone="palm"
              ratio="aspect-[5/4]"
              label="Margaritaville at Sea, pool deck"
            />
          </div>
        </Container>
      </section>

      {/* Featured destinations */}
      <Section spacing="loose">
        <SectionHeading
          eyebrow="Where people go with us"
          title="Featured destinations and trip types"
          intro="A starting point, not a catalogue. If you have somewhere else in mind, ask. We book it all."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map((destination) => (
            <Link
              key={destination.slug}
              href={`/cruises#${destination.slug}`}
              className="group flex flex-col overflow-hidden rounded-2xl border border-navy-100 bg-white transition-shadow hover:shadow-[0_12px_32px_rgba(15,28,43,0.08)]"
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
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-700">
                  {destination.blurb}
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-navy-800 transition-colors group-hover:text-coral-500">
                  Explore
                  <span aria-hidden="true">&rarr;</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </Section>

      {/* How it works */}
      <section className="border-y border-navy-100 bg-sand-50">
        <Container className="py-20 sm:py-24">
          <SectionHeading
            eyebrow="How it works"
            title="Three steps, and most of them are ours"
            align="center"
          />
          <div className="mt-14 grid gap-10 md:grid-cols-3">
            {steps.map((step) => (
              <div key={step.number}>
                <p className="font-display text-3xl font-semibold text-coral-400">
                  {step.number}
                </p>
                <h3 className="mt-3 text-xl font-semibold">{step.title}</h3>
                <p className="mt-3 leading-relaxed text-ink-700">{step.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Testimonials */}
      <Section spacing="loose">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading
            eyebrow="In their words"
            title="What clients say afterwards"
          />
          <Button href="/testimonials" variant="ghost">
            Read all reviews
          </Button>
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {testimonials.slice(0, 3).map((item) => (
            <TestimonialCard key={item.name} item={item} />
          ))}
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
