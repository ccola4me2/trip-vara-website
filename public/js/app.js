// Shared portal front end: API wrapper, formatting, and the app shell.
// Plain ES modules, no bundler, matching the no-build-step deploy model.

// ---------------------------------------------------------------- fetch --
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });

  // A 401 from any page means the session went away. Send them to sign in.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Signed out');
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    err.data = data;
    throw err;
  }
  return data || {};
}

// ----------------------------------------------------------- formatting --
export function money(cents) {
  const n = Number(cents || 0) / 100;
  // Whole dollars stay clean; anything with cents shows both digits. Min and
  // max have to agree, or Intl throws a RangeError.
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function dateFmt(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Unix seconds or an ISO string to "3 days ago". */
export function timeAgo(value) {
  if (!value) return '';
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const secs = Math.round((Date.now() - ms) / 1000);
  const steps = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'],
  ];
  let n = secs;
  let unit = 'second';
  for (const [size, name] of steps) {
    if (Math.abs(n) < size) { unit = name; break; }
    n = n / size;
    unit = name;
  }
  if (unit === 'second' && Math.abs(secs) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return rtf.format(-Math.round(n), unit);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function daysUntil(iso) {
  if (!iso) return null;
  const d = Date.parse(`${iso}T00:00:00`);
  if (!Number.isFinite(d)) return null;
  return Math.ceil((d - Date.now()) / 86400000);
}

// --------------------------------------------------------------- shell ---
const NAV = [
  { href: '/app/', label: 'Dashboard', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
  { href: '/app/inbox', label: 'Inbox', icon: 'M3 8l9 6 9-6M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z' },
  { href: '/app/leads', label: 'Leads', icon: 'M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19M9.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 11h2m-1-1v2' },
  { href: '/app/pipeline', label: 'Pipeline', icon: 'M4 5h16M4 12h10M4 19h6' },
  { href: '/app/calendar', label: 'Calendar', icon: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Zm4-4v4m8-4v4M4 11h16' },
  { href: '/app/bookings', label: 'Bookings', icon: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Zm4-4v4m8-4v4M4 10h16' },
  { href: '/app/billing', label: 'Billing', icon: 'M3 10h18M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm1 8h4' },
  { href: '/app/reports', label: 'Reports', icon: 'M5 20V10m7 10V4m7 16v-7' },
  { href: '/app/settings', label: 'Settings', icon: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a8 8 0 0 1-2 1.2l-.4 2.6h-4l-.4-2.6a8 8 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6A8 8 0 0 1 4 12a8 8 0 0 1 .1-1.2l-2-1.6 2-3.4 2.4 1a8 8 0 0 1 2-1.2L11 3h4l.4 2.6a8 8 0 0 1 2 1.2l2.4-1 2 3.4-2 1.6c.06.4.1.8.1 1.2Z' },
];

const ADMIN_NAV = [
  { href: '/admin/', label: 'Advisors', icon: 'M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19M9.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' },
  { href: '/app/', label: 'Back to portal', icon: 'M10 19l-7-7 7-7M3 12h18' },
];

function navLink(item, current) {
  const active = item.href === current ? ' aria-current="page"' : '';
  return `<a href="${item.href}"${active}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${item.icon}"/></svg>
    ${esc(item.label)}
  </a>`;
}

/**
 * Fills #sidebar, wires sign out and the mobile menu, and returns the signed
 * in user. Every portal page calls this first.
 */
export async function mountShell({ admin = false } = {}) {
  const { user } = await api('/api/auth/me');
  if (!user) { window.location.href = '/login'; throw new Error('Signed out'); }

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return user;

  const current = location.pathname.replace(/index\.html$/, '');
  const items = admin ? ADMIN_NAV : NAV;
  const showAdminLink = !admin && user.role === 'admin';

  sidebar.innerHTML = `
    <a class="wordmark on-dark" href="${admin ? '/admin/' : '/app/'}">
      <img src="/logo-mark.svg" alt="">
      <span><b>TripVara</b><small>${admin ? 'Admin' : 'Advisor portal'}</small></span>
    </a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="sidebar-nav">
      <span class="sr-only">Menu</span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <nav id="sidebar-nav" aria-label="Portal">
      ${items.map((i) => navLink(i, current)).join('')}
      ${showAdminLink ? navLink({ href: '/admin/', label: 'Admin', icon: 'M12 3l8 4v5c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V7l8-4Z' }, current) : ''}
    </nav>
    <div class="sidebar-foot">
      <p class="who">${esc(user.name)}<span>${esc(user.email)}</span></p>
      <button type="button" id="signout">Sign out</button>
    </div>`;

  sidebar.querySelector('#signout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  });

  const toggle = sidebar.querySelector('.menu-toggle');
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  return user;
}

/** Renders an error into a container, with a friendlier GHL setup case. */
export function showError(container, err) {
  if (!container) return;
  if (err && err.code === 'not_configured') {
    container.innerHTML = `<div class="notice-setup">
      <p style="font-size:.72rem;font-weight:650;letter-spacing:.16em;text-transform:uppercase;color:var(--coral-500);margin:0 0 .6rem;">Setup needed</p>
      <h3>GoHighLevel is not connected yet</h3>
      <p style="margin-top:.6rem;">Set the <code>GHL_API_TOKEN</code> secret on the Worker so the portal can
      read contacts, opportunities and calendars from your sub-account. Bookings and reports work without it.</p>
    </div>`;
    return;
  }
  container.innerHTML = `<div class="notice notice-error">${esc((err && err.message) || 'Something went wrong.')}</div>`;
}

/** Small helper for forms: disable while submitting, surface errors. */
export function onSubmit(form, handler, { errorBox } = {}) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    // The notice sits inside the form on dialogs, but is a sibling of it on
    // the auth pages. Look in both before falling back to an alert.
    const box = errorBox
      || form.querySelector('.notice-error')
      || (form.parentElement && form.parentElement.querySelector('.notice-error'));
    if (box) { box.hidden = true; box.textContent = ''; }
    if (button) button.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form).entries()));
    } catch (err) {
      if (box) { box.textContent = err.message || 'Something went wrong.'; box.hidden = false; }
      else alert(err.message || 'Something went wrong.');
    } finally {
      if (button) button.disabled = false;
    }
  });
}
