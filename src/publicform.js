// Publicly hosted forms at /f/<slug>.
//
// Rendered by the Worker rather than served as a static file, because the
// markup depends on the field definitions in D1. Deliberately self-contained:
// no external fonts, no scripts from anywhere else, so it loads fast and
// cannot be broken by a third party going down.
//
// These pages are unauthenticated by design. Everything below assumes hostile
// input.

import { json, badRequest, notFound, uid, now, clean, isValidEmail, normalizeEmail, sha256Hex } from './util.js';
import * as ghl from './ghl.js';
import { upsertContact } from './sync.js';
import { hydrateForm } from './formbuilder.js';
import { fireTrigger } from './automations.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadForm(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first();
  return row ? { row, form: hydrateForm(row) } : null;
}

function fieldMarkup(f) {
  const id = `f_${esc(f.key)}`;
  const req = f.required ? ' required' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  let input;
  if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${esc(f.key)}"${req}${ph}></textarea>`;
  } else if (f.type === 'select') {
    input = `<select id="${id}" name="${esc(f.key)}"${req}>
      <option value="">Choose one</option>
      ${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
    </select>`;
  } else if (f.type === 'checkbox') {
    return `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.key)}" value="yes"${req}>
      <span>${esc(f.label)}</span></label>`;
  } else {
    input = `<input type="${esc(f.type)}" id="${id}" name="${esc(f.key)}"${req}${ph}>`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
}

export async function renderPublicForm(request, env, slug) {
  const found = await loadForm(env, slug);
  if (!found || !found.form.active) {
    return new Response(page('Form unavailable',
      '<h1>This form is not available</h1><p>The link may be out of date. Please get in touch and we will send you a new one.</p>'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const f = found.form;
  const body = `
    <h1>${esc(f.headline || f.name)}</h1>
    ${f.description ? `<p class="lede">${esc(f.description)}</p>` : ''}
    <div class="note error" id="err" hidden></div>
    <div class="note ok" id="ok" hidden></div>
    <form id="form" novalidate>
      ${f.fields.map(fieldMarkup).join('')}
      <!-- Honeypot: a real person never fills this in, a naive bot fills everything. -->
      <div class="hp" aria-hidden="true">
        <label for="company_website">Company website</label>
        <input type="text" id="company_website" name="company_website" tabindex="-1" autocomplete="off">
      </div>
      <button type="submit">${esc(f.submitLabel)}</button>
    </form>
    <script>
      const form = document.getElementById('form');
      const err = document.getElementById('err');
      const ok = document.getElementById('ok');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button');
        btn.disabled = true;
        err.hidden = true;
        try {
          const data = Object.fromEntries(new FormData(form).entries());
          const res = await fetch(${JSON.stringify(`/api/public/forms/${f.slug}`)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          const out = await res.json();
          if (!res.ok) throw new Error(out.error || 'Something went wrong.');
          if (out.redirect) { window.location.href = out.redirect; return; }
          form.hidden = true;
          ok.textContent = out.message;
          ok.hidden = false;
        } catch (e2) {
          err.textContent = e2.message;
          err.hidden = false;
          btn.disabled = false;
        }
      });
    </script>`;

  return new Response(page(f.name, body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handlePublicSubmit(request, env, slug) {
  const found = await loadForm(env, slug);
  if (!found || !found.form.active) return notFound('This form is not available.');
  const { form, row } = found;

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // Rate limit before doing any work. These pages are unauthenticated, so the
  // honeypot below is the only other thing standing between them and a script.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`${slug}:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const since = now() - 3600;
    const seen = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND ip_hash = ? AND created_at > ?'
    ).bind(form.id, ipHash, since).first();
    if ((seen?.n || 0) >= 10) {
      return json({ error: 'Too many submissions from here. Please try again later.' }, 429);
    }
  }

  // Honeypot. Answer as if it worked so a bot learns nothing.
  if (clean(body.company_website, 200)) {
    return json({ ok: true, message: form.successMessage || 'Thanks, we have got it.' });
  }

  const data = {};
  for (const f of form.fields) {
    const raw = clean(body[f.key], f.type === 'textarea' ? 4000 : 300);
    if (f.required && !raw) return badRequest(`${f.label} is required.`);
    if (f.type === 'email' && raw && !isValidEmail(raw)) {
      return badRequest(`${f.label} needs a valid email address.`);
    }
    if (raw) data[f.key] = raw;
  }

  // Pull out whatever looks like identity, whatever the field keys are called.
  const pick = (types, names) => {
    for (const f of form.fields) {
      if (types.includes(f.type) && data[f.key]) return data[f.key];
    }
    for (const f of form.fields) {
      if (names.some((n) => f.key.includes(n) || f.label.toLowerCase().includes(n)) && data[f.key]) {
        return data[f.key];
      }
    }
    return '';
  };
  const email = normalizeEmail(pick(['email'], ['email']));
  const phone = pick(['tel'], ['phone', 'mobile', 'cell']);

  // Name is built from first and last when the form asks for them separately,
  // which is the common case. A single "name" or "full name" field wins only
  // when there is no split pair, otherwise matching on "name" grabs
  // "first_name" and silently drops the surname.
  const byKey = (...names) => {
    for (const f of form.fields) {
      const k = f.key.toLowerCase();
      const l = f.label.toLowerCase();
      if (names.some((n) => k === n || k.includes(n) || l.includes(n)) && data[f.key]) return data[f.key];
    }
    return '';
  };
  const first = byKey('first_name', 'firstname', 'first name');
  const last = byKey('last_name', 'lastname', 'last name');
  const name = (first || last)
    ? [first, last].filter(Boolean).join(' ')
    : byKey('full_name', 'full name', 'your name', 'name');

  const submissionId = uid();
  await env.DB.prepare(
    `INSERT INTO form_submissions
       (id, form_id, location_id, contact_id, name, email, phone, data_json, source, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(submissionId, form.id, row.location_id, null, name || null, email || null,
         phone || null, JSON.stringify(data), `form:${form.slug}`, ipHash, now()).run();

  // Push the contact upstream so messaging and automations still see it. Best
  // effort on purpose: losing a lead because the CRM was rate limiting would
  // be far worse than a contact arriving a few minutes late.
  let contactId = null;
  if (email || phone) {
    try {
      const parts = (name || '').split(/\s+/);
      const contact = await ghl.createContact(env, row.location_id, {
        firstName: parts[0] || undefined,
        lastName: parts.slice(1).join(' ') || undefined,
        email: email || undefined,
        phone: phone || undefined,
        source: `Trip Vara form: ${form.name}`,
      });
      if (contact && contact.id) {
        contactId = contact.id;
        await upsertContact(env, row.location_id, contact);
        await env.DB.prepare('UPDATE form_submissions SET contact_id = ? WHERE id = ?')
          .bind(contact.id, submissionId).run();
      }
    } catch (e) {
      console.error('form contact push', e);
    }
  }

  // Kick off any automations listening for this. Enqueue only, never execute
  // inline: a misconfigured automation must not slow down or fail a lead
  // submission.
  const context = {
    formId: form.id, formName: form.name, formSlug: form.slug,
    contactId: contactId || null, name, email, phone, ...data,
  };
  await fireTrigger(env, row.location_id, 'form.submitted', context);

  // A form submission that produced a new contact is also a new contact, and
  // someone building a "welcome new contact" automation reasonably expects it
  // to cover leads that arrive by form. Only fires when a contact was actually
  // created, so it never double-fires for an anonymous submission.
  if (contactId) {
    await fireTrigger(env, row.location_id, 'contact.created', context);
  }

  return json({
    ok: true,
    message: form.successMessage || 'Thanks, we have got it. We will be in touch shortly.',
    redirect: form.redirectUrl || null,
  }, 201);
}

/** Standalone page shell. No external requests at all. */
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Trip Vara</title>
<link rel="icon" href="/logo-mark.svg" type="image/svg+xml">
<style>
  :root { --navy:#1b3a5f; --navy-d:#12294a; --coral:#f1705b; --ink:#2f4459;
          --line:#e4edf5; --shell:#fbf9f5; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--shell);color:var(--ink);
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased;padding:2rem 1rem}
  .wrap{max-width:560px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:.6rem;margin-bottom:2rem}
  .brand img{width:36px;height:36px}
  .brand b{font-size:1rem;letter-spacing:.26em;text-transform:uppercase;color:var(--navy);font-weight:650}
  .brand small{display:block;font-size:.62rem;letter-spacing:.06em;color:var(--coral)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:2rem;
        box-shadow:0 1px 2px rgba(15,28,43,.05)}
  h1{margin:0 0 .5rem;font-size:1.6rem;line-height:1.25;color:var(--navy);font-weight:650}
  .lede{margin:0 0 1.6rem;color:#5c7286}
  .field{margin-bottom:1.1rem}
  label{display:block;font-size:.85rem;font-weight:600;color:var(--navy);margin-bottom:.35rem}
  .req{color:var(--coral)}
  input,select,textarea{width:100%;font:inherit;padding:.65rem .8rem;border:1px solid #c7d9e9;
        border-radius:9px;background:#fff;color:#0f1c2b}
  input:focus,select:focus,textarea:focus{outline:2px solid var(--coral);outline-offset:1px;border-color:transparent}
  textarea{min-height:110px;resize:vertical}
  .check{display:flex;gap:.6rem;align-items:flex-start;font-weight:400;margin-bottom:1.1rem}
  .check input{width:auto;margin-top:.25rem}
  button{width:100%;background:var(--coral);color:#fff;border:0;border-radius:999px;
         padding:.85rem 1.4rem;font:inherit;font-weight:650;cursor:pointer}
  button:hover{background:#e55942}
  button:disabled{opacity:.6;cursor:not-allowed}
  .note{border-radius:10px;padding:.85rem 1rem;font-size:.9rem;margin-bottom:1.2rem}
  .note.error{background:#fdeeec;color:#b3382a}
  .note.ok{background:#e8f5f0;color:#1f7a5a}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .foot{text-align:center;margin-top:1.5rem;font-size:.78rem;color:#8395a5}
  [hidden]{display:none!important}
</style></head>
<body><div class="wrap">
  <div class="brand"><img src="/logo-mark.svg" alt="">
    <span><b>TripVara</b><small>From first inquiry to welcome home.</small></span></div>
  <div class="card">${body}</div>
  <p class="foot">&copy; ${new Date().getFullYear()} Trip Vara Travel</p>
</div></body></html>`;
}
