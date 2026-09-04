"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogoLockup } from "./Logo";
import { primaryNav, site } from "@/config/site";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-50">
      <div className="hidden bg-navy-900 text-navy-100 md:block">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-8 py-2 text-xs">
          <p className="tracking-[0.08em] text-coral-300">{site.tagline}</p>
          <div className="flex items-center gap-5">
            <a
              className="transition-colors hover:text-white"
              href={`mailto:${site.contact.email}`}
            >
              {site.contact.email}
            </a>
            {site.contact.phone ? (
              <a
                className="transition-colors hover:text-white"
                href={`tel:${site.contact.phone.replace(/[^0-9+]/g, "")}`}
              >
                {site.contact.phone}
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="border-b border-navy-100 bg-shell/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
          <Link href="/" aria-label={`${site.name}, home`}>
            <LogoLockup />
          </Link>

          <nav
            aria-label="Primary"
            className="hidden items-center gap-7 lg:flex"
          >
            {primaryNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "text-coral-500"
                    : "text-ink-700 hover:text-navy-800"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="hidden items-center gap-3 lg:flex">
            <Link
              href="/book"
              className="text-sm font-semibold text-navy-800 transition-colors hover:text-coral-500"
            >
              Book a call
            </Link>
            <Link
              href="/quote"
              className="rounded-full bg-coral-400 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coral-500"
            >
              Get a free quote
            </Link>
          </div>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-navy-200 text-navy-800 lg:hidden"
          >
            <span className="sr-only">
              {open ? "Close menu" : "Open menu"}
            </span>
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {open ? (
                <>
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </>
              ) : (
                <>
                  <path d="M4 7h16" />
                  <path d="M4 12h16" />
                  <path d="M4 17h16" />
                </>
              )}
            </svg>
          </button>
        </div>

        {open ? (
          <nav
            id="mobile-nav"
            aria-label="Primary mobile"
            className="border-t border-navy-100 bg-shell lg:hidden"
          >
            <div className="mx-auto max-w-6xl px-5 py-4 sm:px-8">
              <ul className="flex flex-col">
                {primaryNav.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block border-b border-navy-100 py-3 text-base font-medium ${
                        isActive(item.href) ? "text-coral-500" : "text-navy-800"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex flex-col gap-3">
                <Link
                  href="/quote"
                  className="rounded-full bg-coral-400 px-5 py-3 text-center text-sm font-semibold text-white"
                >
                  Get a free quote
                </Link>
                <Link
                  href="/book"
                  className="rounded-full border border-navy-200 px-5 py-3 text-center text-sm font-semibold text-navy-800"
                >
                  Book a discovery call
                </Link>
              </div>
            </div>
          </nav>
        ) : null}
      </div>
    </header>
  );
}
