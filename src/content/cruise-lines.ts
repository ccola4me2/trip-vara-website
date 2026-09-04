export type CruiseLine = {
  name: string;
  note: string;
  featured?: boolean;
};

export const cruiseLines: CruiseLine[] = [
  {
    name: "Margaritaville at Sea",
    note: "Our specialty. Short Florida sailings with a relaxed, no fuss island feel.",
    featured: true,
  },
  { name: "Royal Caribbean", note: "Big ships, big activity lists, strong for families and first timers." },
  { name: "Carnival", note: "Value forward and social, with the widest set of drive to homeports." },
  { name: "Norwegian", note: "Freestyle dining and flexible schedules, good for couples who dislike fixed seating." },
  { name: "Princess", note: "Classic cruising done well. A standout for Alaska." },
  { name: "Celebrity", note: "Elevated design and food without stepping fully into luxury pricing." },
  { name: "Holland America", note: "Longer, more destination focused itineraries and a calmer onboard pace." },
  { name: "MSC", note: "Strong value in the Caribbean and an easy way into European sailings." },
  { name: "Disney", note: "Unmatched for young families, and it books further out than any other line." },
  { name: "Viking & river cruising", note: "Adults only, all included, and ideal for Europe first timers." },
];

export type ServiceItem = { title: string; body: string };

export const services: ServiceItem[] = [
  {
    title: "Cruises",
    body: "Ocean, river and expedition sailings across every major line, including group space for larger parties.",
  },
  {
    title: "All inclusive resorts",
    body: "Mexico, the Caribbean and Central America, matched to your budget and the vibe you are after.",
  },
  {
    title: "Vacation packages",
    body: "Flights, hotels, transfers and tours booked as one trip, with one person accountable for it.",
  },
  {
    title: "Groups & celebrations",
    body: "Reunions, birthdays, anniversaries and destination weddings, from first inquiry to final payment.",
  },
  {
    title: "Honeymoons",
    body: "Quietly handled upgrades, room requests and the small touches that make the trip feel like yours.",
  },
  {
    title: "Travel protection",
    body: "Plain English guidance on what insurance actually covers, so you can decide with real information.",
  },
];
