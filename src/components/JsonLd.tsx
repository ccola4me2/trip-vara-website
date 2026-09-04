import { site } from "@/config/site";

/**
 * TravelAgency structured data. Helps search engines understand who the
 * business is and surface the brand correctly.
 */
export function JsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "TravelAgency",
    name: site.name,
    legalName: site.legalName,
    url: site.url,
    slogan: site.tagline,
    description: site.description,
    email: site.contact.email,
    ...(site.contact.phone ? { telephone: site.contact.phone } : {}),
    image: `${site.url}/logo-mark.svg`,
    logo: `${site.url}/logo-mark.svg`,
    areaServed: "US",
    knowsAbout: [
      "Margaritaville at Sea",
      "Cruise vacations",
      "All inclusive resorts",
      "Group travel",
      "Destination weddings",
    ],
    founder: {
      "@type": "Person",
      name: site.advisor.name,
      jobTitle: site.advisor.role,
      affiliation: {
        "@type": "Organization",
        name: site.advisor.affiliation,
      },
    },
    ...(site.social.some((s) => s.href)
      ? { sameAs: site.social.filter((s) => s.href).map((s) => s.href) }
      : {}),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
