// Trip Vara's own form builder.
//
// The upstream builder has no create or edit API, so forms made there can only
// ever be read. These are the portal's own: defined here, hosted here at
// /f/<slug>, and submitted into this database.
//
// A submission also creates the contact upstream, so messaging and automations
// keep working, but that push is best effort. Losing a lead because the CRM
// API was rate limiting would be much worse than a contact arriving late.

import {
  json, badRequest, notFound, forbidden, uid, now, clean, oneOf,
  isValidEmail, normalizeEmail, readJson,
} from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import * as db from './db.js';
import { upsertContact } from './sync.js';

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'date', 'number', 'checkbox'];

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'form';
}

function parseFields(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const f of list.slice(0, 40)) {
    const label = clean(f.label, 120);
    if (!label) continue;
    let key = clean(f.key, 60) || slugify(label).replace(/-/g, '_');
    // Keys end up as form input names and submission keys, so they have to be
    // unique within a form or answers overwrite each other.
    let n = 2;
    while (seen.has(key)) key = `${key}_${n++}`;
    seen.add(key);
    out.push({
      key,
      label,
      type: oneOf(f.type, FIELD_TYPES),
      required: Boolean(f.required),
      placeholder: clean(f.placeholder, 120),
      options: Array.isArray(f.options)
        ? f.options.map((o) => clean(o, 80)).filter(Boolean).slice(0, 40)
        : [],
    });
  }
  return out;
}

function hydrate(row) {
  if (!row) return null;
  let fields = [];
  try { fields = JSON.parse(row.fields_json); } catch { fields = []; }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    headline: row.headline || '',
    description: row.description || '',
    fields,
    submitLabel: row.submit_label || 'Send',
    successMessage: row.success_message || '',
    redirectUrl: row.redirect_url || '',
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Portal side
// ---------------------------------------------------------------------------
export async function handleListForms(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const locationId = ghl.locationFor(env, user);

  const { results } = await env.DB.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submissions
       FROM forms f WHERE f.location_id = ? ORDER BY f.updated_at DESC`
  ).bind(locationId).all();

  return json({
    forms: (results || []).map((r) => ({ ...hydrate(r), submissions: r.submissions || 0 })),
  });
}

export async function handleGetForm(request, env, id) {
  const { response } = await requireUser(request, env);
  if (response) return response;
  const row = await env.DB.prepare('SELECT * FROM forms WHERE id = ?').bind(id).first();
  if (!row) return notFound('Form not found.');

  const { results } = await env.DB.prepare(
    'SELECT * FROM form_submissions WHERE form_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(id).all();

  return json({
    form: hydrate(row),
    submissions: (results || []).map((s) => {
      let data = {};
      try { data = JSON.parse(s.data_json); } catch { data = {}; }
      return {
        id: s.id, name: s.name, email: s.email, phone: s.phone,
        contactId: s.contact_id, createdAt: s.created_at, data,
      };
    }),
  });
}

async function uniqueSlug(env, base, excludeId = null) {
  let slug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const row = await env.DB.prepare('SELECT id FROM forms WHERE slug = ?').bind(candidate).first();
    if (!row || row.id === excludeId) return candidate;
  }
  return `${slug}-${uid().slice(0, 6)}`;
}

export async function handleSaveForm(request, env, id = null) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 120);
  if (!name) return badRequest('Give the form a name.');

  const fields = parseFields(body.fields);
  if (!fields.length) return badRequest('Add at least one field.');

  const locationId = ghl.locationFor(env, user);
  const ts = now();
  const slug = await uniqueSlug(env, clean(body.slug, 60) || name, id);

  const shared = [
    slug, name, clean(body.headline, 160), clean(body.description, 600),
    JSON.stringify(fields), clean(body.submitLabel, 40) || 'Send',
    clean(body.successMessage, 400), clean(body.redirectUrl, 300),
    body.active === false ? 0 : 1, ts,
  ];

  if (id) {
    const res = await env.DB.prepare(
      `UPDATE forms SET slug=?, name=?, headline=?, description=?, fields_json=?,
         submit_label=?, success_message=?, redirect_url=?, active=?, updated_at=?
       WHERE id = ? AND location_id = ?`
    ).bind(...shared, id, locationId).run();
    if (!res.meta || res.meta.changes === 0) return notFound('Form not found.');
    await db.logActivity(env, user.id, 'form.update', `Updated form ${name}`, { id });
  } else {
    id = uid();
    await env.DB.prepare(
      `INSERT INTO forms (id, location_id, slug, name, headline, description, fields_json,
         submit_label, success_message, redirect_url, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, locationId, ...shared.slice(0, 9), user.id, ts, ts).run();
    await db.logActivity(env, user.id, 'form.create', `Created form ${name}`, { id });
  }

  const row = await env.DB.prepare('SELECT * FROM forms WHERE id = ?').bind(id).first();
  return json({ ok: true, form: hydrate(row) }, id ? 200 : 201);
}

export async function handleDeleteForm(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const res = await env.DB.prepare('DELETE FROM forms WHERE id = ? AND location_id = ?')
    .bind(id, ghl.locationFor(env, user)).run();
  if (!res.meta || res.meta.changes === 0) return notFound('Form not found.');
  await db.logActivity(env, user.id, 'form.delete', 'Deleted a form', { id });
  return json({ ok: true });
}

export { hydrate as hydrateForm, FIELD_TYPES };
