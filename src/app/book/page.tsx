import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/Container";
import { GhlCalendar } from "@/components/GhlEmbed";
import { Section } from "@/components/Section";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Book a Discovery Call",
  description:
    "Pick a time to talk with Brent Beasley of Trip Vara. A short, no obligation call to work out what trip actually fits you.",
  alternates: { canonical: "/book" },
};

const agenda = [
  "Where you are thinking about going, and roughly when",
  "Who is travelling and what would make the trip worth it",
  "A realistic budget range, so the options we send are useful",
  "What we would recommend, and what we would not",
];

export default function BookPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-harbor absolute inset-0 opacity-85"
        />
        <Container className="relative z-10 py-16 sm:py-20">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            Fifteen minutes, no obligation
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            Book a discovery call
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            Pick a time that works. We will talk through what you are thinking
            and what makes sense. There is nothing to buy at the end of it.
          </p>
        </Container>
      </section>

      <Section spacing="loose">
        <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr]">
          <aside className="space-y-8 lg:order-last">
            <div className="rounded-2xl border border-navy-100 bg-white p-7">
              <h2 className="text-xl font-semibold">What we will cover</h2>
              <ul className="mt-5 space-y-3">
                {agenda.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-coral-400"
                    />
                    <span className="text-sm leading-relaxed text-ink-700">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl bg-sand-100 p-7">
              <h3 className="text-base font-semibold">
                Prefer to skip the call?
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                Send the details in writing instead and you will get a quote
                back. Either route reaches the same person.
              </p>
              <Link
                href="/quote"
                className="mt-4 inline-flex rounded-full bg-coral-400 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coral-500"
              >
                Get a free quote
              </Link>
            </div>

            <p className="text-sm leading-relaxed text-ink-500">
              Nothing on the calendar that works? Email{" "}
              <a
                href={`mailto:${site.contact.email}`}
                className="font-medium text-navy-800 underline underline-offset-4 hover:text-coral-500"
              >
                {site.contact.email}
              </a>{" "}
              and we will find a time. {site.contact.hours}
            </p>
          </aside>

          <div>
            <GhlCalendar />
          </div>
        </div>
      </Section>
    </>
  );
}
