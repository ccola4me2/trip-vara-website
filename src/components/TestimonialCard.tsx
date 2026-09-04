import type { Testimonial } from "@/content/testimonials";

export function TestimonialCard({ item }: { item: Testimonial }) {
  return (
    <figure className="flex h-full flex-col rounded-2xl border border-navy-100 bg-white p-7 shadow-[0_1px_2px_rgba(15,28,43,0.04)]">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-6 w-6 text-coral-300"
        fill="currentColor"
      >
        <path d="M9.5 5C6.5 6.6 4.8 9.3 4.8 12.7V19h6.5v-6.6H8.1c0-2 .8-3.5 2.6-4.6L9.5 5Zm9.4 0c-3 1.6-4.7 4.3-4.7 7.7V19H21v-6.6h-3.2c0-2 .8-3.5 2.6-4.6L18.9 5Z" />
      </svg>
      <blockquote className="mt-4 flex-1 text-[0.98rem] leading-relaxed text-ink-700">
        {item.quote}
      </blockquote>
      <figcaption className="mt-6 border-t border-navy-100 pt-4">
        <p className="font-semibold text-navy-800">{item.name}</p>
        <p className="text-sm text-ink-500">{item.detail}</p>
        {item.trip ? (
          <p className="mt-2 inline-block rounded-full bg-navy-50 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-navy-600 uppercase">
            {item.trip}
          </p>
        ) : null}
      </figcaption>
    </figure>
  );
}
