// Leads and contacts. Read and written straight through to GoHighLevel.

import { json, badRequest, clean, isValidEmail, normalizeEmail, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import { logActivity } from './db.js';

export async function handleListLeads(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  try {
    const result = await ghl.listContacts(env, ghl.locationFor(env, user), {
      query: url.searchParams.get('q') || undefined,
      limit: url.searchParams.get('limit') || 50,
      startAfterId: url.searchParams.get('startAfterId') || undefined,
      startAfter: url.searchParams.get('startAfter') || undefined,
    });
    return json(result);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleGetLead(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  try {
    const [contact, notes] = await Promise.all([
      ghl.getContact(env, contactId),
      ghl.listContactNotes(env, contactId).catch(() => []),
    ]);
    if (!contact) return json({ error: 'Contact not found.' }, 404);
    return json({ contact, notes });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateLead(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const email = normalizeEmail(body.email);
  const phone = clean(body.phone, 40);

  if (!firstName && !lastName) return badRequest('A first or last name is required.');
  if (!email && !phone) return badRequest('An email address or phone number is required.');
  if (email && !isValidEmail(email)) return badRequest('Enter a valid email address.');

  try {
    const contact = await ghl.createContact(env, ghl.locationFor(env, user), {
      firstName, lastName, email, phone,
      source: clean(body.source, 80) || 'Trip Vara portal',
    });
    await logActivity(env, user.id, 'lead.create', `Added lead ${contact.name}`, { contactId: contact.id });
    return json({ ok: true, contact }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleUpdateLead(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const email = body.email === undefined ? undefined : normalizeEmail(body.email);
  if (email && !isValidEmail(email)) return badRequest('Enter a valid email address.');

  try {
    const contact = await ghl.updateContact(env, contactId, {
      firstName: body.firstName === undefined ? undefined : clean(body.firstName, 80),
      lastName: body.lastName === undefined ? undefined : clean(body.lastName, 80),
      email,
      phone: body.phone === undefined ? undefined : clean(body.phone, 40),
    });
    await logActivity(env, user.id, 'lead.update', `Updated ${contact.name}`, { contactId });
    return json({ ok: true, contact });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateLeadNote(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const note = clean(body.body, 4000);
  if (!note) return badRequest('The note is empty.');

  try {
    await ghl.createContactNote(env, contactId, note, user.ghl_user_id || undefined);
    await logActivity(env, user.id, 'lead.note', 'Added a note', { contactId });
    const notes = await ghl.listContactNotes(env, contactId).catch(() => []);
    return json({ ok: true, notes }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
