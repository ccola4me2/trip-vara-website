"use client";

import Script from "next/script";
import { calendarEmbedUrl, formEmbedUrl, ghl } from "@/config/ghl";

function SetupNotice({
  what,
  envVar,
  where,
}: {
  what: string;
  envVar: string;
  where: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-navy-300 bg-navy-50 p-8 text-left">
      <p className="text-xs font-semibold tracking-[0.18em] text-coral-500 uppercase">
        Setup needed
      </p>
      <h3 className="mt-3 text-xl font-semibold">
        The {what} is not connected yet
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-700">
        Set <code className="rounded bg-white px-1.5 py-0.5 text-navy-800">{envVar}</code>{" "}
        in your environment variables to finish this. {where}
      </p>
      <p className="mt-3 text-sm text-ink-500">
        Trip Vara location ID{" "}
        <code className="rounded bg-white px-1.5 py-0.5">{ghl.locationId}</code>
      </p>
    </div>
  );
}

export function GhlForm({
  title = "Trip Vara quote request",
  height = 760,
}: {
  title?: string;
  height?: number;
}) {
  if (!formEmbedUrl) {
    return (
      <SetupNotice
        what="quote form"
        envVar="NEXT_PUBLIC_GHL_FORM_ID"
        where="In GoHighLevel, open Sites, then Forms, then Integrate on your quote form, and copy the id from the embed URL."
      />
    );
  }

  return (
    <>
      <iframe
        src={formEmbedUrl}
        id={`inline-${ghl.formId}`}
        title={title}
        loading="lazy"
        className="w-full rounded-2xl border border-navy-100 bg-white"
        style={{ height, minHeight: 520 }}
        data-layout='{"id":"INLINE"}'
        data-trigger-type="alwaysShow"
        data-form-id={ghl.formId}
        data-form-name={title}
        data-height={String(height)}
        data-layout-iframe-id={`inline-${ghl.formId}`}
      />
      <Script src={ghl.embedScript} strategy="lazyOnload" />
    </>
  );
}

export function GhlCalendar({
  title = "Book a discovery call with Trip Vara",
  height = 760,
}: {
  title?: string;
  height?: number;
}) {
  if (!calendarEmbedUrl) {
    return (
      <SetupNotice
        what="booking calendar"
        envVar="NEXT_PUBLIC_GHL_CALENDAR_ID"
        where="In GoHighLevel, open Calendars, choose your discovery call calendar, select Embed, and copy the id from the embed URL."
      />
    );
  }

  return (
    <>
      <iframe
        src={calendarEmbedUrl}
        id={`${ghl.calendarId}_calendar`}
        title={title}
        loading="lazy"
        scrolling="no"
        className="w-full rounded-2xl border border-navy-100 bg-white"
        style={{ height, minHeight: 620 }}
      />
      <Script src={ghl.embedScript} strategy="lazyOnload" />
    </>
  );
}
