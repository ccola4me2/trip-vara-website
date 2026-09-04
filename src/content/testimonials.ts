export type Testimonial = {
  quote: string;
  name: string;
  detail: string;
  /** Optional, shown as a small label on the card. */
  trip?: string;
};

/**
 * PLACEHOLDER CONTENT.
 * Replace with real, attributable client reviews before launch. Keep the
 * shape of the objects and everything on the site updates automatically.
 */
export const testimonials: Testimonial[] = [
  {
    quote:
      "We had been putting off booking for two years because it felt overwhelming. Brent handled all of it and sent us a single page with everything we needed. We just showed up.",
    name: "Dana R.",
    detail: "Bahamas, 4 night sailing",
    trip: "Margaritaville at Sea",
  },
  {
    quote:
      "Nineteen people, six cabins, and not one argument about logistics. He tracked every deposit and reminded us before final payment. Worth it for that alone.",
    name: "The Whitaker Family",
    detail: "Multi generation family reunion",
    trip: "Group cruise",
  },
  {
    quote:
      "I found a fare online and thought I was doing fine. Brent matched it, then added onboard credit and a better cabin location I would never have known to ask for.",
    name: "Michael T.",
    detail: "Western Caribbean, balcony",
    trip: "7 night cruise",
  },
  {
    quote:
      "Our flight got cancelled the morning we were supposed to leave. One text and he had us rebooked before I finished my coffee. That is the part you cannot get from a website.",
    name: "Karen and Joe P.",
    detail: "Riviera Maya, all inclusive",
    trip: "Resort stay",
  },
  {
    quote:
      "He asked what we actually wanted out of the week instead of just sending prices. The itinerary he came back with was not the one we thought we wanted, and it was better.",
    name: "Alicia M.",
    detail: "Alaska, Inside Passage",
    trip: "Cruise and land tour",
  },
  {
    quote:
      "Straightforward, quick to answer, and never pushy. We have booked three trips with Trip Vara now and will not go back to doing it ourselves.",
    name: "Robert S.",
    detail: "Repeat client since 2022",
  },
];
