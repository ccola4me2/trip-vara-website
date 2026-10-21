// Getting hold of somebody.
//
// The portal had no way to ask a question in it. For a paying agency that is
// an irritation; for a demo it is the whole problem, because the one message
// that matters most is "my trial has ended, how do I carry on", and the person
// sending it is by definition locked out of everything.
//
// So this is deliberately the least gated thing in the portal:
//
//   It does not use requireUser. requireUser refuses an expired demo, which
//   would shut the door on exactly the person this exists for.
//
//   It works signed out. A demo whose trial has ended cannot sign in at all,
//   because handleLogin refuses them too, so a form that needed a session
//   would be unreachable for the case it was built for.
//
// Being open to the internet, it carries the same three guards as every other
// public form here: a honeypot, an hourly limit per address, and Turnstile
// when there are keys for it.
//
// Signed in, it says who is asking and what state their account is in, which
// is what makes an answer possible without a round trip asking which agency
// they are. Signed out, it takes their word for it.

import {
  json, badRequest, clean, cleanText, sha256Hex, isValidEmail, normalizeEmail,
  uid, now, readJson,
} from './util.js';
import { getCurrentUser } from './auth.js';
import { sendSupportEmail } from './email.js';
import { verifyTurnstile, TURNSTILE_FAILED } from './turnstile.js';

// Messages from one address in an hour.
//
// Ten rather than the three this started at, because an address is not a
// person: an agency behind one office connection shares it, and three between
// them is a limit two advisors can reach between themselves on a bad morning.
// The honeypot and Turnstile are what stop a flood; this is the backstop, and
// a backstop that locks out real customers is worse than the flood.
const PER_HOUR = 10;

/**
 * Who is asking, as far as the portal can tell.
 *
 * getCurrentUser rather than requireUser, on purpose. See the note above: the
 * person most likely to need this is the one requireUser turns away.
 */
async function askerFrom(env, request) {
  const user = await getCurrentUser(request, env).catch(() => null);
  if (!user) return null;

  let agency = null;
  if (user.agency_id) {
    agency = await env.DB.prepare(
      'SELECT name, plan, trial_ends_at FROM agencies WHERE id = ?'
    ).bind(user.agency_id).first().catch(() => null);
  }

  const context = [
    ['Account', user.email],
    ['Agency', agency?.name || user.agency_name],
    ['Role', user.role === 'admin' ? 'Agency owner' : 'Advisor'],
  ];

  if (agency?.plan === 'demo') {
    const left = agency.trial_ends_at
      ? Math.ceil((agency.trial_ends_at - now()) / 86400) : null;
    context.push(['Plan', left === null ? 'Demo'
      : left > 0 ? `Demo, ${left} day${left === 1 ? '' : 's'} left`
        : `Demo, ended ${Math.abs(left)} day${Math.abs(left) === 1 ? '' : 's'} ago`]);
  } else if (agency) {
    context.push(['Plan', 'Live']);
  }

  return {
    userId: user.id,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
    email: user.email,
    agencyName: agency?.name || user.agency_name || '',
    context,
  };
}

/** What the page shows before anybody types: who we think they are. */
export async function handleSupportWho(request, env) {
  const asker = await askerFrom(env, request);
  return json({
    signedIn: Boolean(asker),
    name: asker?.name || '',
    email: asker?.email || '',
    agencyName: asker?.agencyName || '',
  });
}

export async function handleSupport(request, env) {
  const body = await readJson(request);

  // Answered as if it worked, so a bot learns nothing.
  if (clean(body.company_website, 200)) {
    return json({ ok: true, message: 'Thanks, we have got it.' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? (await sha256Hex(`support:${ip}`)).slice(0, 32) : null;
  if (ipHash) {
    const seen = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM support_messages
        WHERE ip_hash = ? AND created_at > ?`
    ).bind(ipHash, now() - 3600).first().catch(() => null);
    if ((seen?.n || 0) >= PER_HOUR) {
      return json({ error: 'That is a few messages in a short time. '
        + 'We have the earlier ones and will come back to you.' }, 429);
    }
  }

  if (!await verifyTurnstile(env, body['cf-turnstile-response'], ip)) {
    return badRequest(TURNSTILE_FAILED);
  }

  const asker = await askerFrom(env, request);

  // Signed in, their own details win over anything the form carried: a session
  // is a better answer to "who is this" than a text box.
  const name = asker ? asker.name : clean(body.name, 120);
  const email = asker ? asker.email : normalizeEmail(clean(body.email, 254));
  const subject = clean(body.subject, 160) || 'A question';
  const message = cleanText(body.message, 4000);

  if (!email || !isValidEmail(email)) {
    return badRequest('We need an email address to answer you on.');
  }
  if (!message) return badRequest('Tell us what you need, even roughly.');

  const context = asker
    ? asker.context
    : [['Account', 'Not signed in'], ['Agency', clean(body.agencyName, 160)]];
  const agencyName = asker?.agencyName || clean(body.agencyName, 160) || null;

  // The row first, then the email. Everything else in this portal works this
  // way round, and it matters more here than anywhere: the message is the one
  // thing on that page that exists nowhere else, so a mail service having a
  // bad morning must cost a notification rather than somebody's question.
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO support_messages
       (id, user_id, name, email, agency_name, subject, message, ip_hash, sent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(id, asker?.userId || null, name || null, email, agencyName,
         subject, message, ipHash, now()).run();

  try {
    await sendSupportEmail(env, { name, email, agencyName: agencyName || 'not given',
      subject, message, context });
    await env.DB.prepare('UPDATE support_messages SET sent = 1 WHERE id = ?')
      .bind(id).run().catch(() => {});
  } catch (e) {
    // Kept, and said so. The message is safe either way, and telling somebody
    // it arrived when nobody has been told about it is the one answer that
    // would leave them waiting for a reply that was never coming.
    console.error('support send', e);
    return json({ ok: true, stored: true,
      message: 'We have your message. Our email is having trouble, so if you do not hear '
        + 'back within a day, try again.' });
  }

  return json({ ok: true, message: 'Got it. We will come back to you by email.' });
}
