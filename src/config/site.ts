/**
 * Central site configuration.
 *
 * Anything marked TODO is a placeholder that should be replaced with real
 * business details before launch. Empty strings are treated as "not set" and
 * the matching UI is hidden rather than rendered with fake data.
 */

export const site = {
  name: "Trip Vara",
  legalName: "Trip Vara Travel",
  tagline: "From first inquiry to welcome home.",
  domain: "tripvaratravel.com",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://tripvaratravel.com",
  description:
    "Trip Vara is a full-service travel advisory led by Brent Beasley, an independent advisor affiliated with Cruise Planners. Margaritaville at Sea specialists who also book cruises, resorts and group getaways.",

  advisor: {
    name: "Brent Beasley",
    role: "Independent Travel Advisor",
    affiliation: "Cruise Planners",
  },

  // TODO: replace with the real published contact details.
  contact: {
    email: "brent@tripvaratravel.com",
    // Leave phone empty until confirmed. Empty values are hidden site wide.
    phone: "",
    // Free text, shown in the footer and on the contact page.
    serviceArea: "Serving clients nationwide, by phone, video and email",
    hours: "Monday to Friday, 9am to 6pm ET. Evenings and weekends by appointment.",
  },

  // TODO: add real profile URLs. Entries with an empty href are not rendered.
  social: [
    { label: "Facebook", href: "" },
    { label: "Instagram", href: "" },
    { label: "YouTube", href: "" },
  ],
};

export type NavItem = { label: string; href: string };

export const primaryNav: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "About", href: "/about" },
  { label: "Cruises & Destinations", href: "/cruises" },
  { label: "Reviews", href: "/testimonials" },
  { label: "Contact", href: "/contact" },
];

export const footerNav: NavItem[] = [
  ...primaryNav,
  { label: "Get a Quote", href: "/quote" },
  { label: "Book a Call", href: "/book" },
];
