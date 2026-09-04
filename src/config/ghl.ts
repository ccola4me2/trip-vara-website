/**
 * GoHighLevel CRM wiring for the Trip Vara sub-account.
 *
 * Sub-account dashboard:
 * https://app.concinnity.digital/v2/location/4Hb35fhCOJSuOmKDA1bY/dashboard
 *
 * To finish the integration, set NEXT_PUBLIC_GHL_FORM_ID and
 * NEXT_PUBLIC_GHL_CALENDAR_ID in .env.local (and in the Vercel project
 * environment variables). Until they are set, the quote and booking pages
 * render a clearly labelled setup notice instead of a broken iframe.
 */

export const ghl = {
  /** Trip Vara sub-account location ID. */
  locationId: "4Hb35fhCOJSuOmKDA1bY",

  /** Sites > Forms > Integrate, the id in .../widget/form/<id> */
  formId: process.env.NEXT_PUBLIC_GHL_FORM_ID ?? "",

  /** Calendars > Embed, the id in .../widget/booking/<id> */
  calendarId: process.env.NEXT_PUBLIC_GHL_CALENDAR_ID ?? "",

  /** LeadConnector widget host. Unchanged by white labelling. */
  widgetBase: "https://api.leadconnectorhq.com/widget",

  /** Script that handles iframe auto resizing for GHL embeds. */
  embedScript: "https://link.msgsndr.com/js/form_embed.js",
} as const;

export const formEmbedUrl = ghl.formId
  ? `${ghl.widgetBase}/form/${ghl.formId}`
  : "";

export const calendarEmbedUrl = ghl.calendarId
  ? `${ghl.widgetBase}/booking/${ghl.calendarId}`
  : "";
