import type { Metadata } from "next";
import { Button } from "@/components/Button";
import { Container } from "@/components/Container";
import { CtaBand } from "@/components/CtaBand";
import { PhotoFrame } from "@/components/PhotoFrame";
import { Section, SectionHeading } from "@/components/Section";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "About Brent Beasley",
  description:
    "Meet Brent Beasley, the independent travel advisor behind Trip Vara. Cruise Planners affiliated, Margaritaville at Sea specialist, and the person who answers when you call.",
  alternates: { canonical: "/about" },
};

const credentials = [
  {
    title: "Cruise Planners affiliated",
    body: "Trip Vara operates as an independent franchise within Cruise Planners, which means the buying power and supplier relationships of a national agency behind a single, local advisor.",
  },
  {
    title: "Margaritaville at Sea specialist",
    body: "This is the line we sail and book most. That familiarity turns into better cabin picks, better timing and fewer surprises for you.",
  },
  {
    title: "Group and celebration travel",
    body: "Reunions, milestone birthdays and destination weddings, including group space, amenity points and payment tracking across every cabin.",
  },
  {
    title: "Supplier trained and certified",
    body: "Ongoing training across cruise lines, resort brands and destinations, plus firsthand ship and resort visits.",
  },
];

const values = [
  {
    title: "Straight answers",
    body: "If a sailing is wrong for you, we say so. A trip you regret is worse for us than a booking we did not take.",
  },
  {
    title: "No extra cost to you",
    body: "We are paid by the travel suppliers, not by you. In most cases you pay the same or less than booking direct, and you get an advocate.",
  },
  {
    title: "One point of contact",
    body: "The same person plans the trip, books it and picks up when something changes at 6am in an airport.",
  },
];

export default function AboutPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-harbor absolute inset-0 opacity-80"
        />
        <Container className="relative z-10 py-20 sm:py-24">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            About Trip Vara
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            The agency is one person. That is on purpose.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            {site.advisor.name}, {site.advisor.role} affiliated with{" "}
            {site.advisor.affiliation}.
          </p>
        </Container>
      </section>

      <Section spacing="loose">
        <div className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <PhotoFrame
            tone="dune"
            ratio="aspect-[4/5]"
            className="lg:sticky lg:top-32"
            label="Portrait of Brent Beasley"
          />
          <div className="space-y-5 text-lg leading-relaxed text-ink-700">
            <h2 className="text-3xl font-semibold sm:text-4xl">
              How Trip Vara started
            </h2>
            <p>
              It started the way most of these do. A few friends asked which
              sailing to book. Then their friends asked. Then people we had
              never met were emailing questions about cabin categories and
              whether the drink package was worth it.
            </p>
            <p>
              For years that work ran under the name Parrot Heads Cruising,
              built around a community of people who loved the same music, the
              same islands and the same unhurried way of taking a vacation. It
              grew past what that name could hold. Clients were asking about
              Alaska, about Europe, about all inclusive resorts and family
              reunions that had nothing to do with a cruise ship.
            </p>
            <p>
              Trip Vara is the same person doing the same work with a name that
              fits all of it. The tagline is the promise:{" "}
              <em className="text-navy-800">
                from first inquiry to welcome home.
              </em>{" "}
              Not just the booking. The whole arc of the trip.
            </p>
            <h2 className="pt-4 text-3xl font-semibold sm:text-4xl">
              Why work with an advisor at all
            </h2>
            <p>
              You can book a cruise in nine minutes on your phone. Plenty of
              people should. The value shows up in the parts a search box cannot
              price: which deck to avoid, which itinerary looks identical on
              paper and is not, what happens when a port is cancelled or a
              connection is missed.
            </p>
            <p>
              It also shows up in the boring parts. Deposits tracked, final
              payment dates flagged before they pass, documents in one place,
              and a single person who remembers the trip you took last year when
              planning the next one.
            </p>
          </div>
        </div>
      </Section>

      <section className="border-y border-navy-100 bg-sand-50">
        <Container className="py-20 sm:py-24">
          <SectionHeading
            eyebrow="Credentials and affiliations"
            title="What stands behind the advice"
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {credentials.map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-navy-100 bg-white p-7"
              >
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="mt-3 leading-relaxed text-ink-700">{item.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <Section spacing="loose">
        <SectionHeading
          eyebrow="How we work"
          title="Three things you can hold us to"
          align="center"
        />
        <div className="mt-12 grid gap-10 md:grid-cols-3">
          {values.map((value) => (
            <div key={value.title}>
              <div
                aria-hidden="true"
                className="h-1 w-10 rounded-full bg-coral-400"
              />
              <h3 className="mt-5 text-xl font-semibold">{value.title}</h3>
              <p className="mt-3 leading-relaxed text-ink-700">{value.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-wrap justify-center gap-3">
          <Button href="/quote" size="lg">
            Get a free quote
          </Button>
          <Button href="/book" variant="ghost" size="lg">
            Book a discovery call
          </Button>
        </div>
      </Section>

      <CtaBand
        eyebrow="Let's talk"
        title="Start with a conversation, not a checkout page"
        body="Fifteen minutes on the phone usually saves a week of second guessing. There is nothing to buy at the end of it."
      />
    </>
  );
}
