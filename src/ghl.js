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
  constructor(message, status = 502, detail = null, httpStatus = null) {
    super(message);
    this.name = 'GhlError';
    // Status we hand back to our own client, which is not always the upstream
    // one: most GHL failures become a 502 so the portal reads as "upstream
    // problem" rather than leaking GHL's status into our API.
    this.status = status;
    // The status GoHighLevel actually returned. Kept because the capability
    // probe has to tell 403 (scope missing) from 404 (endpoint not available),
    // and remapping both to 502 would make that impossible.
    this.httpStatus = httpStatus;
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

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to GoHighLevel.
 *
 * Retries rate limits and transient upstream errors with backoff. GHL returns
 * these often enough under normal use that a single failure was surfacing to
 * advisors as "check your scopes", which sent them looking for a configuration problem
 * that did not exist. Auth and validation failures are never retried, since
 * repeating them cannot change the answer.
 */
async function request(env, path, { method = 'GET', query, body } = {}) {
  if (!ghlConfigured(env)) {
    throw new GhlError('Trip Vara Tools is not connected yet.', 503, { code: 'not_configured' });
  }

  const url = new URL(apiBase(env) + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      lastError = new GhlError('Could not reach Trip Vara Tools.', 502, String(e));
      if (attempt < MAX_ATTEMPTS) { await sleep(attempt * 400); continue; }
      throw lastError;
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (res.ok) return data || {};

    if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
      // Honour Retry-After when GHL sends one, otherwise back off linearly.
      const retryAfter = Number(res.headers.get('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 4000)
        : attempt * 500);
      continue;
    }

    throw new GhlError(messageFor(res.status, data), statusFor(res.status), data, res.status);
  }

  throw lastError || new GhlError('Trip Vara Tools did not respond.', 502);
}

/** Plain language for the failures an advisor can actually act on. */
function messageFor(status, data) {
  if (status === 401) {
    return 'Trip Vara Tools rejected the API token. It may have been revoked or replaced.';
  }
  if (status === 403) {
    return 'The API token is missing the permission for this. Check its scopes in Trip Vara Tools.';
  }
  if (status === 429) {
    return 'Trip Vara Tools is rate limiting us. Give it a moment and try again.';
  }
  if (status === 404) return 'Trip Vara Tools could not find that record.';
  return (data && (data.message || data.error)) || `Trip Vara Tools returned ${status}.`;
}

function statusFor(status) {
  if (status === 429) return 429;
  if (status === 401 || status === 403) return status;
  return 502;
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
// Conversations and messages
// ---------------------------------------------------------------------------
export async function searchConversations(env, locationId, { contactId, query, limit = 40 } = {}) {
  const data = await request(env, '/conversations/search', {
    query: {
      locationId,
      contactId: contactId || undefined,
      query: query || undefined,
      limit: Math.min(Number(limit) || 40, 100),
    },
  });
  return (data.conversations || []).map((c) => ({
    id: pickId(c),
    contactId: c.contactId || null,
    contactName: c.fullName || c.contactName || '',
    email: c.email || '',
    phone: c.phone || '',
    lastMessageBody: c.lastMessageBody || '',
    lastMessageType: c.lastMessageType || '',
    lastMessageDate: c.lastMessageDate || null,
    unreadCount: Number(c.unreadCount || 0),
    type: c.type || '',
  }));
}

export async function listMessages(env, conversationId, { limit = 50 } = {}) {
  const data = await request(env, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    query: { limit: Math.min(Number(limit) || 50, 100) },
  });
  // GHL nests the page under messages.messages on this endpoint.
  const list = data.messages?.messages || data.messages || [];
  return (Array.isArray(list) ? list : []).map((m) => ({
    id: pickId(m),
    body: m.body || '',
    type: m.messageType || m.type || '',
    // 1 = inbound from the contact, 2 = outbound from the advisor.
    direction: m.direction || (m.type === 1 ? 'inbound' : 'outbound'),
    status: m.status || '',
    createdAt: m.dateAdded || m.createdAt || null,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
  }));
}

export async function sendMessage(env, { contactId, type, message, subject, html, conversationId }) {
  const data = await request(env, '/conversations/messages', {
    method: 'POST',
    body: {
      type,                       // SMS | Email
      contactId,
      conversationId: conversationId || undefined,
      message: message || undefined,
      subject: subject || undefined,
      html: html || undefined,
    },
  });
  return { id: pickId(data), conversationId: data.conversationId || conversationId || null };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export async function listContactTasks(env, contactId) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}/tasks`);
  return (data.tasks || []).map((t) => ({
    id: pickId(t),
    title: t.title || '',
    body: t.body || '',
    dueDate: t.dueDate || null,
    completed: Boolean(t.completed),
    assignedTo: t.assignedTo || null,
  }));
}

export async function createContactTask(env, contactId, { title, body, dueDate, assignedTo }) {
  const data = await request(env, `/contacts/${encodeURIComponent(contactId)}/tasks`, {
    method: 'POST',
    body: { title, body: body || undefined, dueDate: dueDate || undefined, assignedTo: assignedTo || undefined, completed: false },
  });
  return { id: pickId(data.task || data), title };
}

export async function setTaskCompleted(env, contactId, taskId, completed) {
  await request(env, `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}/completed`, {
    method: 'PUT',
    body: { completed: Boolean(completed) },
  });
  return { id: taskId, completed: Boolean(completed) };
}

// ---------------------------------------------------------------------------
// Location metadata: custom fields, tags, users
// ---------------------------------------------------------------------------
export async function listCustomFields(env, locationId) {
  const data = await request(env, `/locations/${encodeURIComponent(locationId)}/customFields`);
  return (data.customFields || []).map((f) => ({
    id: pickId(f),
    name: f.name || '',
    fieldKey: f.fieldKey || '',
    dataType: f.dataType || '',
    model: f.model || 'contact',
  }));
}

export async function listTags(env, locationId) {
  const data = await request(env, `/locations/${encodeURIComponent(locationId)}/tags`);
  return (data.tags || []).map((t) => ({ id: pickId(t), name: t.name || '' }));
}

export async function listUsers(env, locationId) {
  const data = await request(env, '/users/', { query: { locationId } });
  return (data.users || []).map((u) => ({
    id: pickId(u),
    name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' '),
    email: u.email || '',
    role: u.roles?.role || '',
  }));
}

// ---------------------------------------------------------------------------
// Appointments (write)
// ---------------------------------------------------------------------------
export async function createAppointment(env, locationId, f) {
  const data = await request(env, '/calendars/events/appointments', {
    method: 'POST',
    body: {
      locationId,
      calendarId: f.calendarId,
      contactId: f.contactId,
      startTime: f.startTime,
      endTime: f.endTime || undefined,
      title: f.title || undefined,
      appointmentStatus: f.status || 'confirmed',
      assignedUserId: f.assignedUserId || undefined,
    },
  });
  const e = data.event || data.appointment || data;
  return { id: pickId(e), title: e.title || f.title || '', startTime: e.startTime || f.startTime };
}

// ---------------------------------------------------------------------------
// Invoices and payments
//
// These endpoints scope by altId/altType rather than locationId, and reject a
// request that omits offset, so the shared helper below fills both in.
//
// Money: GHL returns amounts in whole currency units here, unlike the portal's
// own bookings which store integer cents. Everything is converted to cents on
// the way in so one formatter works across the whole UI.
// ---------------------------------------------------------------------------
function altQuery(locationId, { limit = 50, offset = 0, ...rest } = {}) {
  return {
    altId: locationId,
    altType: 'location',
    limit: Math.min(Number(limit) || 50, 100),
    offset: String(offset ?? 0),
    ...rest,
  };
}

const toCentsFromUnits = (n) => Math.round(Number(n || 0) * 100);

export function normalizeInvoice(i) {
  if (!i) return null;
  const contact = i.contactDetails || i.contact || {};
  return {
    id: pickId(i),
    number: i.invoiceNumber || i.number || '',
    name: i.name || i.title || '',
    // draft | sent | payment_processing | paid | void | partially_paid
    status: (i.status || '').toLowerCase(),
    currency: i.currency || 'USD',
    totalCents: toCentsFromUnits(i.total ?? i.amount),
    paidCents: toCentsFromUnits(i.amountPaid ?? i.paidAmount ?? 0),
    dueCents: toCentsFromUnits(i.amountDue ?? i.dueAmount ?? 0),
    issueDate: i.issueDate || i.createdAt || null,
    dueDate: i.dueDate || null,
    contactId: i.contactId || pickId(contact) || null,
    contactName:
      contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '',
    contactEmail: contact.email || '',
  };
}

export function normalizeTransaction(t) {
  if (!t) return null;
  const contact = t.contactSnapshot || t.contact || {};
  return {
    id: pickId(t),
    status: (t.status || '').toLowerCase(),
    amountCents: toCentsFromUnits(t.amount),
    currency: t.currency || 'USD',
    entityType: t.entityType || t.entitySourceType || '',
    createdAt: t.createdAt || t.dateAdded || null,
    contactId: t.contactId || pickId(contact) || null,
    contactName:
      contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '',
    paymentProvider: t.paymentProviderType || t.paymentProvider || '',
  };
}

export async function listInvoices(env, locationId, opts = {}) {
  const data = await request(env, '/invoices/', { query: altQuery(locationId, opts) });
  const list = data.invoices || data.data || [];
  return {
    invoices: (Array.isArray(list) ? list : []).map(normalizeInvoice).filter(Boolean),
    total: Number(data.total ?? list.length ?? 0),
  };
}

export async function listTransactions(env, locationId, opts = {}) {
  const data = await request(env, '/payments/transactions', { query: altQuery(locationId, opts) });
  const list = data.data || data.transactions || [];
  return {
    transactions: (Array.isArray(list) ? list : []).map(normalizeTransaction).filter(Boolean),
    total: Number(data.totalCount ?? data.total ?? list.length ?? 0),
  };
}

export async function listOrders(env, locationId, opts = {}) {
  const data = await request(env, '/payments/orders', { query: altQuery(locationId, opts) });
  const list = data.data || data.orders || [];
  return {
    orders: (Array.isArray(list) ? list : []).map((o) => ({
      id: pickId(o),
      status: (o.status || '').toLowerCase(),
      amountCents: toCentsFromUnits(o.amount),
      currency: o.currency || 'USD',
      createdAt: o.createdAt || null,
      contactId: o.contactId || null,
      contactName: o.contactSnapshot?.name || '',
      source: o.sourceType || o.source || '',
    })).filter(Boolean),
    total: Number(data.totalCount ?? data.total ?? list.length ?? 0),
  };
}

export async function listSubscriptions(env, locationId, opts = {}) {
  const data = await request(env, '/payments/subscriptions', { query: altQuery(locationId, opts) });
  const list = data.data || data.subscriptions || [];
  return (Array.isArray(list) ? list : []).map((sub) => ({
    id: pickId(sub),
    status: (sub.status || '').toLowerCase(),
    amountCents: toCentsFromUnits(sub.amount),
    currency: sub.currency || 'USD',
    contactId: sub.contactId || null,
    contactName: sub.contactSnapshot?.name || '',
    createdAt: sub.createdAt || null,
  }));
}

// ---------------------------------------------------------------------------
// Workflows
//
// Workflows can be listed and a contact can be pushed into one. Authoring a
// workflow has no API and stays in GoHighLevel.
// ---------------------------------------------------------------------------
export async function listWorkflows(env, locationId) {
  const data = await request(env, '/workflows/', { query: { locationId } });
  return (data.workflows || []).map((w) => ({
    id: pickId(w),
    name: w.name || 'Workflow',
    status: w.status || '',
    createdAt: w.createdAt || null,
  })).filter((w) => w.id);
}

export async function addContactToWorkflow(env, contactId, workflowId) {
  await request(env, `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(workflowId)}`, {
    method: 'POST',
    body: { eventStartTime: new Date().toISOString() },
  });
  return { contactId, workflowId };
}

export async function removeContactFromWorkflow(env, contactId, workflowId) {
  await request(env, `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
  });
  return { contactId, workflowId };
}

// ---------------------------------------------------------------------------
// Forms and submissions
// ---------------------------------------------------------------------------
export async function listForms(env, locationId, { limit = 50 } = {}) {
  const data = await request(env, '/forms/', {
    query: { locationId, limit: Math.min(Number(limit) || 50, 100), skip: 0 },
  });
  return (data.forms || []).map((f) => ({
    id: pickId(f),
    name: f.name || 'Form',
    createdAt: f.createdAt || null,
  })).filter((f) => f.id);
}

export async function listFormSubmissions(env, locationId, { formId, limit = 50, page = 1, q } = {}) {
  const data = await request(env, '/forms/submissions', {
    query: {
      locationId,
      formId: formId || undefined,
      q: q || undefined,
      limit: Math.min(Number(limit) || 50, 100),
      page,
    },
  });
  const list = data.submissions || [];
  return {
    submissions: list.map((s) => {
      // Everything beyond the known keys is the answers the person typed.
      const known = new Set(['id', '_id', 'formId', 'name', 'email', 'phone', 'contactId', 'createdAt', 'formName', 'others', 'pageDetails', 'eventData']);
      const answers = Object.entries(s)
        .filter(([k, v]) => !known.has(k) && v !== null && v !== '' && typeof v !== 'object')
        .map(([k, v]) => ({ label: k, value: String(v) }));
      return {
        id: pickId(s),
        formId: s.formId || null,
        formName: s.formName || '',
        name: s.name || '',
        email: s.email || '',
        phone: s.phone || '',
        contactId: s.contactId || null,
        createdAt: s.createdAt || null,
        answers,
      };
    }),
    total: Number(data.meta?.total ?? list.length ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Scope probe
//
// A missing scope on the Private Integration Token surfaces as a 401 or 403,
// not as an empty result. This pings one cheap read per area so an admin can
// see exactly which parts of the token are usable, without reading the GHL
// UI and guessing.
// ---------------------------------------------------------------------------
export async function probeScopes(env, locationId) {
  const checks = {
    contacts: () => request(env, '/contacts/', { query: { locationId, limit: 1 } }),
    opportunities: () => request(env, '/opportunities/pipelines', { query: { locationId } }),
    conversations: () => request(env, '/conversations/search', { query: { locationId, limit: 1 } }),
    calendars: () => request(env, '/calendars/', { query: { locationId } }),
    customFields: () => request(env, `/locations/${encodeURIComponent(locationId)}/customFields`),
    tags: () => request(env, `/locations/${encodeURIComponent(locationId)}/tags`),
    users: () => request(env, '/users/', { query: { locationId } }),
  };

  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, run]) => {
      try {
        await run();
        return [name, { ok: true }];
      } catch (e) {
        const status = e instanceof GhlError ? e.status : 502;
        return [name, {
          ok: false,
          status,
          reason: status === 403 ? 'scope or permission denied'
            : status === 401 ? 'token rejected'
            : e.message,
        }];
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Wide capability probe.
 *
 * Walks a cheap read for every GoHighLevel v2 area worth knowing about and
 * reports what this token can actually reach. Distinguishes:
 *   available    200, usable today
 *   noScope      403, the token lacks that permission
 *   noEndpoint   404, not exposed on this plan or path not available
 *   rejected     401, token problem
 *
 * Runs in small batches so a wide sweep does not trip GHL's burst limit.
 */
export async function probeCapabilities(env, locationId) {
  const loc = encodeURIComponent(locationId);
  const alt = { altId: locationId, altType: 'location', limit: 1 };
  // The invoice and media endpoints reject a request that omits these, with a
  // 422 rather than a 4xx about permissions, so they have to be sent even for
  // a probe that only cares whether the area is reachable.
  const paged = { ...alt, offset: '0' };

  const areas = [
    ['contacts', 'Contacts', () => request(env, '/contacts/', { query: { locationId, limit: 1 } })],
    ['conversations', 'Conversations', () => request(env, '/conversations/search', { query: { locationId, limit: 1 } })],
    ['opportunities', 'Opportunities and pipelines', () => request(env, '/opportunities/pipelines', { query: { locationId } })],
    ['calendars', 'Calendars', () => request(env, '/calendars/', { query: { locationId } })],
    ['users', 'Users', () => request(env, '/users/', { query: { locationId } })],
    ['customFields', 'Custom fields', () => request(env, `/locations/${loc}/customFields`)],
    ['customValues', 'Custom values', () => request(env, `/locations/${loc}/customValues`)],
    ['tags', 'Tags', () => request(env, `/locations/${loc}/tags`)],
    ['location', 'Location settings', () => request(env, `/locations/${loc}`)],
    ['forms', 'Forms', () => request(env, '/forms/', { query: { locationId, limit: 1 } })],
    ['formSubmissions', 'Form submissions', () => request(env, '/forms/submissions', { query: { locationId, limit: 1 } })],
    ['surveys', 'Surveys', () => request(env, '/surveys/', { query: { locationId, limit: 1 } })],
    ['surveySubmissions', 'Survey submissions', () => request(env, '/surveys/submissions', { query: { locationId, limit: 1 } })],
    ['workflows', 'Workflows', () => request(env, '/workflows/', { query: { locationId } })],
    ['campaigns', 'Campaigns', () => request(env, '/campaigns/', { query: { locationId } })],
    ['triggerLinks', 'Trigger links', () => request(env, '/links/', { query: { locationId } })],
    ['businesses', 'Businesses', () => request(env, '/businesses/', { query: { locationId } })],
    ['invoices', 'Invoices', () => request(env, '/invoices/', { query: paged })],
    ['invoiceTemplates', 'Invoice templates', () => request(env, '/invoices/template', { query: paged })],
    ['orders', 'Payment orders', () => request(env, '/payments/orders', { query: alt })],
    ['transactions', 'Transactions', () => request(env, '/payments/transactions', { query: alt })],
    ['subscriptions', 'Subscriptions', () => request(env, '/payments/subscriptions', { query: alt })],
    ['products', 'Products', () => request(env, '/products/', { query: { locationId, limit: 1 } })],
    ['media', 'Media library', () => request(env, '/medias/files', { query: { ...alt, sortBy: 'createdAt', sortOrder: 'desc', type: 'file' } })],
    ['blogs', 'Blogs', () => request(env, '/blogs/site/all', { query: { locationId, limit: 1, skip: 0 } })],
    ['funnels', 'Funnels', () => request(env, '/funnels/funnel/list', { query: { locationId } })],
    ['social', 'Social planner', () => request(env, `/social-media-posting/${loc}/accounts`)],
    ['emailTemplates', 'Email templates', () => request(env, '/emails/builder', { query: { locationId, limit: 1 } })],
    ['objects', 'Custom objects', () => request(env, '/objects/', { query: { locationId } })],
    ['courses', 'Courses and memberships', () => request(env, `/courses/courses`, { query: { locationId } })],
  ];

  const out = {};
  const BATCH = 5;
  for (let i = 0; i < areas.length; i += BATCH) {
    const slice = areas.slice(i, i + BATCH);
    const settled = await Promise.all(slice.map(async ([key, label, run]) => {
      try {
        await run();
        return [key, { label, state: 'available' }];
      } catch (e) {
        const http = e instanceof GhlError ? e.httpStatus : null;
        const state =
          http === 403 ? 'noScope'
          : http === 404 ? 'noEndpoint'
          : http === 401 ? 'rejected'
          : 'error';
        return [key, { label, state, httpStatus: http, message: e.message }];
      }
    }));
    for (const [k, v] of settled) out[k] = v;
    if (i + BATCH < areas.length) await sleep(350);
  }
  return out;
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
    error: e instanceof GhlError ? e.message : 'Unexpected error talking to Trip Vara Tools.',
    ...(notConfigured ? { code: 'not_configured' } : {}),
  };
  if (!(e instanceof GhlError)) console.error('ghl unexpected', e);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
