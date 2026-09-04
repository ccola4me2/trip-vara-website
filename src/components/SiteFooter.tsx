import Link from "next/link";
import { LogoLockup } from "./Logo";
import { Container } from "./Container";
import { footerNav, site } from "@/config/site";

const year = new Date().getFullYear();

export function SiteFooter() {
  const socials = site.social.filter((item) => item.href.length > 0);

  return (
    <footer className="bg-navy-900 text-navy-100">
      <Container className="py-14 sm:py-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <LogoLockup variant="inverse" withTagline />
            <p className="mt-5 max-w-sm text-sm leading-relaxed text-navy-200">
              {site.advisor.name}, {site.advisor.role} affiliated with{" "}
              {site.advisor.affiliation}. Cruises, resorts and group travel
              planned end to end, with one person accountable for the whole
              trip.
            </p>
            <p className="mt-4 text-sm text-navy-300">
              {site.contact.serviceArea}
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-[0.16em] text-white uppercase">
              Explore
            </h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              {footerNav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-navy-200 transition-colors hover:text-coral-300"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold tracking-[0.16em] text-white uppercase">
              Get in touch
            </h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li>
                <a
                  href={`mailto:${site.contact.email}`}
                  className="text-navy-200 transition-colors hover:text-coral-300"
                >
                  {site.contact.email}
                </a>
              </li>
              {site.contact.phone ? (
                <li>
                  <a
                    href={`tel:${site.contact.phone.replace(/[^0-9+]/g, "")}`}
                    className="text-navy-200 transition-colors hover:text-coral-300"
                  >
                    {site.contact.phone}
                  </a>
                </li>
              ) : null}
              <li className="pt-1 text-navy-300">{site.contact.hours}</li>
            </ul>

            {socials.length > 0 ? (
              <ul className="mt-5 flex gap-4 text-sm">
                {socials.map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      className="text-navy-200 transition-colors hover:text-coral-300"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-navy-300 sm:flex-row sm:items-center sm:justify-between">
          <p>
            &copy; {year} {site.legalName}. All rights reserved.
          </p>
          <p>
            Independent travel advisor affiliated with{" "}
            {site.advisor.affiliation}. Florida Seller of Travel and other state
            registrations available on request.
          </p>
        </div>
      </Container>
    </footer>
  );
}
