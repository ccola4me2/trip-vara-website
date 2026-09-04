export type Destination = {
  slug: string;
  name: string;
  kicker: string;
  blurb: string;
  /** Tone key consumed by PhotoFrame to pick a placeholder gradient. */
  tone: "reef" | "sunset" | "harbor" | "dune" | "deep" | "palm";
  highlights: string[];
};

export const destinations: Destination[] = [
  {
    slug: "margaritaville-at-sea",
    name: "Margaritaville at Sea",
    kicker: "Our specialty",
    blurb:
      "Short, easy sailings from Florida with the island state of mind built in. This is the line we know best, from the cabin categories that are worth the upgrade to the sailings that fill first.",
    tone: "sunset",
    highlights: ["Palm Beach and Tampa departures", "Bahamas and Western Caribbean", "Two to seven night sailings"],
  },
  {
    slug: "caribbean",
    name: "The Caribbean",
    kicker: "Warm water classics",
    blurb:
      "Eastern, Western and Southern itineraries across every major cruise line. We match the islands to the kind of trip you actually want, whether that is beach days or a packed excursion list.",
    tone: "reef",
    highlights: ["Year round sailings", "Great for first time cruisers", "Easy add on resort stays"],
  },
  {
    slug: "alaska",
    name: "Alaska",
    kicker: "Big scenery",
    blurb:
      "Glacier days, wildlife and small port towns. Timing matters more here than anywhere else, and so does which side of the ship your balcony faces.",
    tone: "deep",
    highlights: ["May through September", "Glacier Bay and Inside Passage", "Cruisetour land extensions"],
  },
  {
    slug: "mexico-riviera",
    name: "Mexico & the Riviera Maya",
    kicker: "Sun and short flights",
    blurb:
      "All inclusive resorts, adults only escapes and family friendly stays along the Caribbean coast, plus Pacific coast sailings out of California.",
    tone: "palm",
    highlights: ["All inclusive resorts", "Adults only options", "Great value shoulder season"],
  },
  {
    slug: "europe",
    name: "Europe & the Mediterranean",
    kicker: "Once in a lifetime",
    blurb:
      "Greek islands, the Amalfi Coast, Northern Europe and river cruising. These trips reward planning early, and they are the ones clients most often wish they had booked sooner.",
    tone: "harbor",
    highlights: ["Ocean and river options", "Pre and post cruise city stays", "Small ship itineraries"],
  },
  {
    slug: "groups-celebrations",
    name: "Groups & Celebrations",
    kicker: "Bring everyone",
    blurb:
      "Reunions, milestone birthdays, destination weddings and friend groups. Group space often unlocks perks and amenity points that individual bookings never see.",
    tone: "dune",
    highlights: ["Group rates and amenities", "One point of contact", "Payment tracking for every cabin"],
  },
];
