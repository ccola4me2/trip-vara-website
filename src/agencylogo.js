// An agency's logo, uploaded instead of pasted as a link.
//
// logo_url has always been an address on the agency's own site. That is fine once an agency has a
// site and a poor first task for one that does not, and a link to somebody else's server breaks
// the day they tidy it up. So the picture can live in the private bucket instead.
//
// The bucket has no addresses of its own, and a logo is the one thing that has to be seen by
// people with no account: it is on a client's page, on a quote, in an email. So it is not served
// from the bucket but through the Worker at /al/<agency id>, for anybody.
//
// Only pictures, and only ones whose first bytes say they are. What is served goes out with the
// type it was found to be and with sniffing switched off, so it can never run as anything else.
//
// All of this is the group hero picture's arrangement, deliberately: it is the same problem and
// copying its shape is cheaper than a second opinion about it.

import { json, badRequest, notFound, uid, now } from './util.js';
import { requireAdmin } from './auth.js';
import { appUrl } from './share.js';
import { docsReady } from './documents.js';
import { sniffPicture } from './grouppicture.js';
import * as db from './db.js';

const MAX_BYTES = 2 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const notReady = () => json({ error: 'Uploads are not switched on for this portal.' }, 503);

/** Their own agency, or anybody's if they run the portal. The same rule as renaming one. */
async function mayEdit(request, env, id) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return { response };
  if (!user.platform_owner && user.agency_id !== id) {
    return { response: json({ error: 'That is not your agency.' }, 403) };
  }
  const agency = await env.DB.prepare(
    'SELECT id, logo_key, logo_url FROM agencies WHERE id = ?'
  ).bind(id).first();
  if (!agency) return { response: notFound('Agency not found.') };
  return { user, agency };
}

/** POST /api/agencies/:id/logo : the picture, as a form upload. */
export async function handleUploadAgencyLogo(request, env, id) {
  const { user, agency, response } = await mayEdit(request, env, id);
  if (response) return response;
  if (!docsReady(env)) return notReady();

  let form;
  try { form = await request.formData(); } catch { form = null; }
  const file = form && form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return badRequest('Choose a picture to upload.');
  if (!file.size) return badRequest('That file is empty.');
  if (file.size > MAX_BYTES) {
    return badRequest(`That picture is ${(file.size / 1048576).toFixed(1)} MB. The limit is 2 MB.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffPicture(bytes);
  if (!type) return badRequest('That is not a JPEG, PNG, WebP or GIF picture.');

  const key = `agencies/${id}/logo-${uid()}.${EXT[type]}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: type } });

  const ts = now();
  // The address carries a version, so a page that cached the old one still catches up.
  const url = `${appUrl(env)}/al/${encodeURIComponent(id)}?v=${ts}`;
  await env.DB.prepare(
    'UPDATE agencies SET logo_key = ?, logo_url = ?, updated_at = ? WHERE id = ?'
  ).bind(key, url, ts, id).run();

  // The one it replaces, once the new one is safely in. A failure here leaves a stray file and
  // nothing else, which is the right way round.
  if (agency.logo_key) await env.DOCS.delete(agency.logo_key).catch(() => {});

  await db.logActivity(env, user.id, 'agency.logo', 'Uploaded an agency logo', { id });
  return json({ ok: true, url });
}

/** DELETE /api/agencies/:id/logo : takes the uploaded logo off. */
export async function handleRemoveAgencyLogo(request, env, id) {
  const { user, agency, response } = await mayEdit(request, env, id);
  if (response) return response;

  if (agency.logo_key && docsReady(env)) await env.DOCS.delete(agency.logo_key).catch(() => {});
  // The address is cleared only if it is the uploaded one: a link somebody pasted is left alone.
  const own = String(agency.logo_url || '').includes(`/al/${id}`);
  await env.DB.prepare(
    `UPDATE agencies SET logo_key = NULL,
            logo_url = CASE WHEN ? = 1 THEN NULL ELSE logo_url END, updated_at = ?
      WHERE id = ?`
  ).bind(own ? 1 : 0, now(), id).run();

  await db.logActivity(env, user.id, 'agency.logo', 'Removed an agency logo', { id });
  return json({ ok: true, cleared: own });
}

/**
 * GET /al/<agency id> : the logo, for anybody.
 *
 * Public with no condition on it, unlike a group's picture, which is served only while that
 * group's page is on. A logo is on a client's own page, on a quote and in an email, and those
 * outlive any one switch: a logo that stopped loading because something unrelated was turned off
 * would be a broken picture in correspondence somebody already has.
 */
export async function serveAgencyLogo(request, env, id) {
  if (!docsReady(env)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(
    'SELECT logo_key FROM agencies WHERE id = ? AND logo_key IS NOT NULL'
  ).bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });

  const object = await env.DOCS.get(row.logo_key);
  if (!object) return new Response('Not found', { status: 404 });
  const type = TYPE_OF_EXT[String(row.logo_key).split('.').pop()] || 'application/octet-stream';
  return new Response(object.body, {
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
