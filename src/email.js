// Transactional email via Resend.
//
// Every send is best effort: if RESEND_API_KEY is not configured, or the API
// call fails, the calling request still succeeds. Account creation must never
// fail because an email did not go out.

const BRAND_NAVY = '#1b3a5f';
const BRAND_CORAL = '#f1705b';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function appUrl(env) {
  return (env.APP_URL || 'https://tripvaratravel.com').replace(/\/$/, '');
}

function layout(env, { heading, body, cta }) {
  const url = appUrl(env);
  const button = cta
    ? `<tr><td style="padding:8px 0 24px;">
         <a href="${escapeHtml(cta.href)}"
            style="display:inline-block;background:${BRAND_CORAL};color:#fff;text-decoration:none;
                   font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px;">
           ${escapeHtml(cta.label)}
         </a></td></tr>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fbf9f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf9f5;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:560px;background:#ffffff;border:1px solid #e4edf5;border-radius:14px;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr><td style="background:${BRAND_NAVY};border-radius:14px 14px 0 0;padding:22px 32px;">
        <span style="color:#fff;font-size:17px;font-weight:600;letter-spacing:.22em;">TRIPVARA</span><br>
        <span style="color:${BRAND_CORAL};font-size:11px;letter-spacing:.06em;">From first inquiry to welcome home.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font-size:21px;font-weight:600;color:${BRAND_NAVY};padding-bottom:14px;">
            ${escapeHtml(heading)}
          </td></tr>
          <tr><td style="font-size:15px;line-height:1.6;color:#2f4459;padding-bottom:22px;">${body}</td></tr>
          ${button}
        </table>
      </td></tr>
      <tr><td style="border-top:1px solid #e4edf5;padding:18px 32px;font-size:12px;color:#5c7286;">
        Trip Vara advisor portal &middot; <a href="${url}" style="color:${BRAND_NAVY};">${escapeHtml(url.replace(/^https?:\/\//, ''))}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function send(env, { to, subject, html }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.log('email skipped, RESEND_API_KEY not set:', subject, '->', to);
    return { skipped: true };
  }
  const recipients = Array.isArray(to) ? to : String(to).split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { skipped: true };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Trip Vara <noreply@tripvaratravel.com>',
        to: recipients,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error('resend error', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('resend threw', e);
    return { ok: false };
  }
}

function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export function sendAdvisorPendingEmail(env, user) {
  return send(env, {
    to: user.email,
    subject: 'Your Trip Vara portal request is in review',
    html: layout(env, {
      heading: 'Thanks, we have your request',
      body: `<p style="margin:0 0 12px;">Hi ${escapeHtml(user.first_name || 'there')},</p>
             <p style="margin:0 0 12px;">Your request for access to the Trip Vara advisor portal has been
             received and is waiting on approval. You will get another email the moment it is active.</p>
             <p style="margin:0;">Nothing else is needed from you right now.</p>`,
    }),
  });
}

export function sendAdvisorApprovedEmail(env, user) {
  return send(env, {
    to: user.email,
    subject: 'Your Trip Vara portal access is active',
    html: layout(env, {
      heading: 'You are in',
      body: `<p style="margin:0 0 12px;">Hi ${escapeHtml(user.first_name || 'there')},</p>
             <p style="margin:0;">Your advisor account is approved. Sign in to see your leads, pipeline
             and bookings in one place.</p>`,
      cta: { label: 'Sign in to the portal', href: `${appUrl(env)}/login` },
    }),
  });
}

export function sendAdminNewSignupEmail(env, user) {
  const to = env.NOTIFY_EMAIL;
  if (!to) return Promise.resolve({ skipped: true });
  return send(env, {
    to,
    subject: `Portal access request: ${fullName(user)}`,
    html: layout(env, {
      heading: 'An advisor is waiting for approval',
      body: `<p style="margin:0 0 12px;"><strong>${escapeHtml(fullName(user))}</strong>
             (${escapeHtml(user.email)}) requested access to the advisor portal.</p>
             <p style="margin:0;">Agency: ${escapeHtml(user.agency_name || 'not given')}<br>
             Phone: ${escapeHtml(user.phone || 'not given')}</p>`,
      cta: { label: 'Review in admin', href: `${appUrl(env)}/admin/` },
    }),
  });
}

export function sendPasswordResetEmail(env, user, token) {
  const minutes = Number(env.RESET_TTL_MINUTES || 60);
  return send(env, {
    to: user.email,
    subject: 'Reset your Trip Vara portal password',
    html: layout(env, {
      heading: 'Reset your password',
      body: `<p style="margin:0 0 12px;">Use the button below to set a new password. The link is good for
             ${minutes} minutes and can only be used once.</p>
             <p style="margin:0;">If you did not ask for this, you can ignore this email. Nothing changes
             until the link is used.</p>`,
      cta: { label: 'Set a new password', href: `${appUrl(env)}/reset-password?token=${encodeURIComponent(token)}` },
    }),
  });
}
