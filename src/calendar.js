// Calendars and appointments, read and written through to GoHighLevel.
//
// The events endpoint needs a calendar, user or group to scope by, so this
// fans out across the sub-account's active calendars and merges the results
// rather than asking the caller to pick one first.

import { json, badRequest, clean, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import { logActivity } from './db.js';

const DAY_MS = 86400000;

export async function handleListCalendar(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 180);
  const start = Date.now() - DAY_MS;           // include yesterday, so "today" is never empty by an hour
  const end = Date.now() + days * DAY_MS;

  const locationId = ghl.locationFor(env, user);

  try {
    const calendars = await ghl.listCalendars(env, locationId);
    const active = calendars.filter((c) => c.isActive);

    if (!active.length) return json({ calendars, events: [], days });

    // One request per calendar, and a calendar that errors is dropped rather
    // than failing the whole view.
    const perCalendar = await Promise.all(
      active.map((c) =>
        ghl.listAppointments(env, locationId, {
          calendarId: c.id,
          startTime: start,
          endTime: end,
        })
          .then((events) => events.map((e) => ({ ...e, calendarId: c.id, calendarName: c.name })))
          .catch(() => [])
      )
    );

    const events = perCalendar.flat().sort(
      (a, b) => Date.parse(a.startTime || 0) - Date.parse(b.startTime || 0)
    );

    return json({ calendars, events, days });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateAppointment(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const calendarId = clean(body.calendarId, 64);
  const contactId = clean(body.contactId, 64);
  const startTime = clean(body.startTime, 40);

  if (!calendarId) return badRequest('Choose a calendar.');
  if (!contactId) return badRequest('Pick a contact.');
  if (!startTime) return badRequest('Choose a start time.');

  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) return badRequest('That start time is not a valid date.');

  const minutes = Math.min(Math.max(Number(body.durationMinutes) || 30, 5), 480);

  try {
    const appointment = await ghl.createAppointment(env, ghl.locationFor(env, user), {
      calendarId,
      contactId,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + minutes * 60000).toISOString(),
      title: clean(body.title, 160) || undefined,
      assignedUserId: user.ghl_user_id || undefined,
    });
    await logActivity(env, user.id, 'appointment.create',
      `Booked ${appointment.title || 'an appointment'}`, { contactId, calendarId });
    return json({ ok: true, appointment }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
