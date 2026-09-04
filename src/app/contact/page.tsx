import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/Container";
import { GhlForm } from "@/components/GhlEmbed";
import { Section } from "@/components/Section";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with Trip Vara. Email Brent Beasley, send a quote request, or book a discovery call.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  const socials = site.social.filter((item) => item.href.length > 0);

  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-900">
        <div
          aria-hidden="true"
          className="photo-grain photo-dune absolute inset-0 opacity-85"
        />
        <Container className="relative z-10 py-16 sm:py-20">
          <p className="text-xs font-semibold tracking-[0.22em] text-coral-300 uppercase">
            Contact
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl leading-tight font-semibold text-white sm:text-5xl">
            Get in touch
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-navy-100">
            Questions, quotes or just thinking out loud about somewhere you want
            to go. Every message reaches {site.advisor.name} directly.
          </p>
        </Container>
      </section>

      <Section spacing="loose">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
          <aside className="space-y-8">
            <div>
              <h2 className="text-xl font-semibold">Direct</h2>
              <ul className="mt-4 space-y-3 text-ink-700">
                <li>
                  <span className="block text-xs font-semibold tracking-[0.16em] text-ink-400 uppercase">
                    Email
                  </span>
                  <a
                    href={`mailto:${site.contact.email}`}
                    className="font-medium text-navy-800 underline underline-offset-4 hover:text-coral-500"
                  >
                    {site.contact.email}
                  </a>
                </li>
                {site.contact.phone ? (
                  <li>
                    <span className="block text-xs font-semibold tracking-[0.16em] text-ink-400 uppercase">
                      Phone
                    </span>
                    <a
                      href={`tel:${site.contact.phone.replace(/[^0-9+]/g, "")}`}
                      className="font-medium text-navy-800 underline underline-offset-4 hover:text-coral-500"
                    >
                      {site.contact.phone}
                    </a>
                  </li>
                ) : null}
                <li>
                  <span className="block text-xs font-semibold tracking-[0.16em] text-ink-400 uppercase">
                    Hours
                  </span>
                  {site.contact.hours}
                </li>
                <li>
                  <span className="block text-xs font-semibold tracking-[0.16em] text-ink-400 uppercase">
                    Where we work
                  </span>
                  {site.contact.serviceArea}
                </li>
              </ul>
            </div>

            {socials.length > 0 ? (
              <div>
                <h2 className="text-xl font-semibold">Follow along</h2>
                <ul className="mt-4 space-y-2">
                  {socials.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-navy-800 underline underline-offset-4 hover:text-coral-500"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="rounded-2xl bg-sand-100 p-7">
              <h3 className="text-base font-semibold">Rather talk?</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                Grab a time on the calendar and we will call you.
              </p>
              <Link
                href="/book"
                className="mt-4 inline-flex rounded-full bg-navy-800 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-navy-700"
              >
                Book a discovery call
              </Link>
            </div>
          </aside>

          <div>
            <h2 className="text-xl font-semibold">Send a message</h2>
            <p className="mt-2 mb-6 text-sm leading-relaxed text-ink-700">
              Use the form below for anything, whether it is a full quote
              request or a single question.
            </p>
            <GhlForm title="Trip Vara contact form" />
          </div>
        </div>
      </Section>
    </>
  );
}
