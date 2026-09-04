// GoHighLevel API client (LeadConnector v2).
//
// GHL is the system of record for contacts, opportunities, notes, tasks and
// appointments. This module is the only place that talks to it, and it
// normalizes every response into a stable shape so the UI never depends on
// GHL's field naming.
//
// Credentials
// -----------
// GHL_API_TOKEN is a secret (`wrangler secret put GHL_API_TOKEN`). Use a
// Private Integration Token scoped to the sub-account, or an agency token that
// can reach every advisor sub-account.
//
// Tenancy
// -------
// Each advisor resolves to a location id: their own `ghl_location_id` when set
// in D1, otherwise GHL_DEFAULT_LOCATION_ID from wrangler.toml. That covers
// both models, one shared Trip Vara sub-account and one sub-account per
// advisor, without changing this file.

export class GhlError extends Error {
  constructor(message, status = 502, detail = null) {
    super(message);
    this.name = 'GhlError';
    this.status = status;
    this.detail = detail;
  }
}

export function ghlConfigured(env) {
  return Boolean(env.GHL_API_TOKEN);
}

/** The GHL sub-account this user works in. */
export function locationFor(env, user) {
  return (user && user.ghl_location_id) || env.GHL_DEFAULT_LOCATION_ID || '';
}

function apiBase(env) {
  return (env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
}

async function request(env, path, { method = 'GET', query, body } = {}) {
  if (!ghlConfigured(env)) {
    throw new GhlError('GoHighLevel is not connected yet.', 503, { code: 'not_configured' });
  }

  const url = new URL(apiBase(env) + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${env.GHL_API_TOKEN}`,
        Version: env.GHL_API_VERSION || '2021-07-28',
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new GhlError('Could not reach GoHighLevel.', 502, String(e));
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const message =
      res.status === 401 || res.status === 403
        ? 'GoHighLevel rejected the request. Check the API token and its scopes.'
        : (data && (data.message || data.error)) || `GoHighLevel returned ${res.status}.`;
    throw new GhlError(message, res.status === 429 ? 429 : 502, data);
  }
  return data || {};
}

// ---------------------------------------------------------------------------
// Normalizers
//
// GHL is inconsistent about id casing and nesting across endpoints, so every
// read goes through these and the rest of the portal only sees these shapes.
// ---------------------------------------------------------------------------
function pickId(o) {
  return o?.id || o?._id || o?.contactId || o?.opportunityId || null;
}

export function normalizeContact(c) {
  if (!c) return null;
  const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '';
  return {
    id: pickId(c),
    name: name || c.email || 'Unnamed contact',
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    email: c.email || '',
    phone: c.phone || '',
    source: c.source || '',
    tags: Array.isArray(c.tags) ? c.tags : [],
    assignedTo: c.assignedTo || null,
    createdAt: c.dateAdded || c.createdAt || null,
    updatedAt: c.dateUpdated || c.updatedAt || null,
    country: c.country || '',
    city: c.city || '',
    state: c.state || '',
  };
}

export function normalizeOpportunity(o) {
  if (!o) return null;
  const contact = o.contact || {};
  return {
    id: pickId(o),
    name: o.name || contact.name || 'Untitled opportunity',
    status: o.status || '',            // open | won | lost | abandoned
    stageId: o.pipelineStageId || o.stageId || null,
    pipelineId: o.pipelineId || null,
    monetaryValue: Number(o.monetaryValue || 0),
    assignedTo: o.assignedTo || null,
    contactId: o.contactId || pickId(contact) || null,
    contactName:
      contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '',
    contactEmail: contact.email || '',
    contactPhone: contact.phone || '',
    source: o.source || '',
    createdAt: o.createdAt || o.dateAdded || null,
    updatedAt: o.updatedAt || o.dateUpdated || null,
  };
}

export function normalizePipeline(p) {
  if (!p) return null;
  return {
    id: pickId(p),
    name: p.name || 'Pipeline',
    stages: (p.stages || []).map((s) => ({
      id: pickId(s),
      name: s.name || 'Stage',
      position: Number(s.position ?? 0),
    })).sort((a, b) => a.position - b.position),
  };
}

// ---------------------------------------------------------------------------
// Contacts and leads
// ---------------------------------------------------------------------------
export async function listContacts(env, locationId, { query, limit = 50, startAfterId, startAfter } = {}) {
  const data = await request(env, '/contacts/', {
    query: {
      locationId,
      limit: Math.min(Number(limit) || 50, 100),
      query: query || undefined,
      startAfterId: startAfterId || undefined,
      startAfter: startAfter || undefined,
    },
  });
  const list = data.contacts || data.contact || [];
  return {
    contacts: (Array.isArray(list) ? list : [list]).map(normalizeContact).filter(Boolean),
    total: Number(data.meta?.total ?? data.total ?? 0),
    nextStartAfterId: data.meta?.startAfterId || null,
    nextStartAfter: data.meta?.startAfter || null,
  };
}

export async function getContact(env, contactId) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}`);
  return normalizeContact(data.contact || data);
}

export async function createContact(env, locationId, fields) {
  const data = await request(env, '/contacts/', {
    method: 'POST',
    body: {
      locationId,
      firstName: fields.firstName || undefined,
      lastName: fields.lastName || undefined,
      email: fields.email || undefined,
      phone: fields.phone || undefined,
      source: fields.source || 'Trip Vara portal',
      tags: fields.tags || undefined,
    },
  });
  return normalizeContact(data.contact || data);
}

export async function updateContact(env, contactId, fields) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    body: {
      firstName: fields.firstName || undefined,
      lastName: fields.lastName || undefined,
      email: fields.email || undefined,
      phone: fields.phone || undefined,
      tags: fields.tags || undefined,
    },
  });
  return normalizeContact(data.contact || data);
}

export async function listContactNotes(env, contactId) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}/notes`);
  const notes = data.notes || [];
  return notes.map((n) => ({
    id: pickId(n),
    body: n.body || '',
    createdAt: n.dateAdded || n.createdAt || null,
    createdBy: n.userId || null,
  }));
}

export async function createContactNote(env, contactId, body, userId) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: 'POST',
    body: { body, userId: userId || undefined },
  });
  return { id: pickId(data.note || data), body };
}

// ---------------------------------------------------------------------------
// Pipelines and opportunities
// ---------------------------------------------------------------------------
export async function listPipelines(env, locationId) {
  const data = await request(env, '/opportunities/pipelines', { query: { locationId } });
  return (data.pipelines || []).map(normalizePipeline).filter(Boolean);
}

export async function searchOpportunities(env, locationId, { pipelineId, status, assignedTo, query, limit = 100, page = 1 } = {}) {
  const data = await request(env, '/opportunities/search', {
    query: {
      location_id: locationId,
      pipeline_id: pipelineId || undefined,
      status: status || undefined,
      assigned_to: assignedTo || undefined,
      q: query || undefined,
      limit: Math.min(Number(limit) || 100, 100),
      page,
    },
  });
  return {
    opportunities: (data.opportunities || []).map(normalizeOpportunity).filter(Boolean),
    total: Number(data.meta?.total ?? data.total ?? 0),
  };
}

export async function createOpportunity(env, locationId, fields) {
  const data = await request(env, '/opportunities/', {
    method: 'POST',
    body: {
      locationId,
      pipelineId: fields.pipelineId,
      pipelineStageId: fields.stageId || undefined,
      contactId: fields.contactId,
      name: fields.name,
      status: fields.status || 'open',
      monetaryValue: Number(fields.monetaryValue || 0),
      assignedTo: fields.assignedTo || undefined,
    },
  });
  return normalizeOpportunity(data.opportunity || data);
}

export async function updateOpportunity(env, opportunityId, fields) {
  const body = {};
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.status !== undefined) body.status = fields.status;
  if (fields.stageId !== undefined) body.pipelineStageId = fields.stageId;
  if (fields.monetaryValue !== undefined) body.monetaryValue = Number(fields.monetaryValue || 0);
  if (fields.assignedTo !== undefined) body.assignedTo = fields.assignedTo;

  const data = await request(env, `/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: 'PUT',
    body,
  });
  return normalizeOpportunity(data.opportunity || data);
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------
export async function listCalendars(env, locationId) {
  const data = await request(env, '/calendars/', { query: { locationId } });
  return (data.calendars || []).map((c) => ({
    id: pickId(c),
    name: c.name || 'Calendar',
    isActive: c.isActive !== false,
  }));
}

export async function listAppointments(env, locationId, { calendarId, startTime, endTime, userId } = {}) {
  const data = await request(env, '/calendars/events', {
    query: {
      locationId,
      calendarId: calendarId || undefined,
      userId: userId || undefined,
      startTime,
      endTime,
    },
  });
  return (data.events || []).map((e) => ({
    id: pickId(e),
    title: e.title || 'Appointment',
    startTime: e.startTime || null,
    endTime: e.endTime || null,
    status: e.appointmentStatus || e.status || '',
    contactId: e.contactId || null,
  }));
}

// ---------------------------------------------------------------------------
// Error to response
//
// Turns a GhlError into a JSON response the UI can render honestly, including
// the "not connected yet" case, which is a configuration state rather than a
// failure and should not read like a crash.
// ---------------------------------------------------------------------------
export function ghlErrorResponse(e) {
  const notConfigured = e instanceof GhlError && e.detail && e.detail.code === 'not_configured';
  const status = e instanceof GhlError ? e.status : 502;
  const body = {
    error: e instanceof GhlError ? e.message : 'Unexpected error talking to GoHighLevel.',
    ...(notConfigured ? { code: 'not_configured' } : {}),
  };
  if (!(e instanceof GhlError)) console.error('ghl unexpected', e);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
