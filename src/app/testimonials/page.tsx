import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/Container";
import { CtaBand } from "@/components/CtaBand";
import { Section, SectionHeading } from "@/components/Section";
import { TestimonialCard } from "@/components/TestimonialCard";
import { testimonials } from "@/content/testimonials";

export const metadata: Metadata = {
  title: "Reviews",
  description:
    "What Trip Vara clients say about planning cruises, resorts and group trips with Brent Beasley.",
  alternates: { canonical: "/testimonials" },
};

const stats = [
  { value: "Repeat clients", label: "Most trips come from people who booked before" },
  { value: "Same day replies", label: "During business hours, from a real person" },
  { value: "Groups welcome", label: "From two travellers to dozens of cabins" },
];

export default function TestimonialsPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-palm absolute inset-0 opacity-85"
        />
        <Container className="relative z-10 py-20 sm:py-24">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            Reviews
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            The part we cannot say about ourselves
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            Feedback from people who let us plan their vacation, in their own
            words.
          </p>
        </Container>
      </section>

      <Section spacing="loose">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((item) => (
            <TestimonialCard key={item.name} item={item} />
          ))}
        </div>
      </Section>

      <section className="border-y border-navy-100 bg-sand-50">
        <Container className="py-16 sm:py-20">
          <div className="grid gap-10 sm:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.value}>
                <p className="font-display text-2xl font-semibold text-navy-800">
                  {stat.value}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink-700">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <Section width="narrow" className="text-center">
        <SectionHeading
          eyebrow="Travelled with us?"
          title="We would love to hear how it went"
          intro="Reviews are how a one person agency gets found. If Trip Vara planned your trip, a few sentences goes a long way."
          align="center"
        />
        <Link
          href="/contact"
          className="mt-8 inline-flex rounded-full border border-navy-200 bg-white px-6 py-3 text-sm font-semibold text-navy-800 transition-colors hover:border-navy-400 hover:bg-navy-50"
        >
          Leave a review
        </Link>
      </Section>

      <CtaBand
        eyebrow="Your turn"
        title="Let's plan the trip they are talking about"
        body="Send a few details and get a personal quote back, free and with no obligation."
      />
    </>
  );
}
