import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/Container";
import { GhlForm } from "@/components/GhlEmbed";
import { Section } from "@/components/Section";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Get a Free Quote",
  description:
    "Tell Trip Vara where you want to go and get a personal, no obligation travel quote. Cruises, all inclusive resorts and group trips, planned by an independent advisor.",
  alternates: { canonical: "/quote" },
};

const reassurances = [
  {
    title: "It costs nothing",
    body: "Quotes and planning are free. We are paid by the travel suppliers, so you pay the same or less than booking direct.",
  },
  {
    title: "No pressure, ever",
    body: "You get options and honest guidance. If the timing is wrong, we will tell you that too.",
  },
  {
    title: "A real reply, quickly",
    body: "Most quotes go out within one business day, written by a person who read what you sent.",
  },
];

const faqs = [
  {
    q: "What if I do not know my dates yet?",
    a: "That is normal and it is fine. A rough month and a rough length is enough to start. Flexibility often saves the most money.",
  },
  {
    q: "Do you charge a planning fee?",
    a: "No fee for cruises, resorts and standard packages. If a trip ever requires custom research that would carry a fee, you will know the amount before any work starts.",
  },
  {
    q: "I already found a price online. Can you match it?",
    a: "Usually, and often we can add something on top of it such as onboard credit, a better cabin location or a group amenity. Send us the price you found.",
  },
  {
    q: "How many people can you book?",
    a: "From a solo traveller to a reunion with dozens of cabins. Larger parties frequently unlock group rates that individual bookings never see.",
  },
];

export default function QuotePage() {
  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-deep absolute inset-0"
        />
        <Container className="relative z-10 py-16 sm:py-20">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            Free, no obligation
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            Get your personal travel quote
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            Fill in what you know. Gaps are fine. The more you tell us about the
            trip you are picturing, the more useful the first reply will be.
          </p>
        </Container>
      </section>

      <Section spacing="loose">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <GhlForm />
          </div>

          <aside className="space-y-8">
            <div className="rounded-2xl border border-navy-100 bg-white p-7">
              <h2 className="text-xl font-semibold">
                What happens after you hit send
              </h2>
              <ol className="mt-5 space-y-4">
                {[
                  "We read it and reply, usually within one business day.",
                  "If anything is unclear, we ask a couple of short questions.",
                  "You get options with the trade offs and pricing spelled out.",
                  "You decide. Nothing is booked until you say so.",
                ].map((step, index) => (
                  <li key={step} className="flex gap-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-xs font-semibold text-white"
                    >
                      {index + 1}
                    </span>
                    <span className="text-sm leading-relaxed text-ink-700">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-6">
              {reassurances.map((item) => (
                <div key={item.title}>
                  <h3 className="flex items-center gap-2 text-base font-semibold text-navy-800">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-coral-400"
                    />
                    {item.title}
                  </h3>
                  <p className="mt-1.5 pl-3.5 text-sm leading-relaxed text-ink-700">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl bg-sand-100 p-7">
              <h3 className="text-base font-semibold">
                Would rather just talk it through?
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                Book a short discovery call instead, or email{" "}
                <a
                  href={`mailto:${site.contact.email}`}
                  className="font-medium text-navy-800 underline underline-offset-4 hover:text-coral-500"
                >
                  {site.contact.email}
                </a>
                .
              </p>
              <Link
                href="/book"
                className="mt-4 inline-flex rounded-full bg-navy-800 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-navy-700"
              >
                Book a discovery call
              </Link>
            </div>
          </aside>
        </div>
      </Section>

      <section className="border-t border-navy-100 bg-white">
        <Container width="narrow" className="py-20 sm:py-24">
          <h2 className="text-3xl font-semibold sm:text-4xl">
            Questions people ask first
          </h2>
          <dl className="mt-10 divide-y divide-navy-100 border-y border-navy-100">
            {faqs.map((faq) => (
              <div key={faq.q} className="py-6">
                <dt className="text-lg font-semibold text-navy-800">{faq.q}</dt>
                <dd className="mt-2.5 leading-relaxed text-ink-700">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>
    </>
  );
}
