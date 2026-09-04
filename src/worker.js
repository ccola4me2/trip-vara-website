// Trip Vara advisor portal Worker.
//
// Routes the JSON API, gates the portal pages behind a session (and /admin
// behind the admin role), and serves the static files in ./public.
//
// [assets] run_worker_first = true in wrangler.toml is what makes the gate
// real: every request lands here first, and protected HTML is only served
// after the session check passes.

import { redirect, notFound, json } from './util.js';
import {
  handleSignup, handleLogin, handleLogout, handleMe,
  handleForgot, handleReset, handleChangePassword, handleUpdateProfile,
  getCurrentUser, isAdmin,
} from './auth.js';
import {
  handleListLeads, handleGetLead, handleCreateLead, handleUpdateLead, handleCreateLeadNote,
  handleContactDetail, handleCreateTask, handleToggleTask,
} from './leads.js';
import {
  handleListPipelines, handleListOpportunities,
  handleCreateOpportunity, handleUpdateOpportunity,
} from './pipeline.js';
import {
  handleListBookings, handleGetBooking, handleCreateBooking,
  handleUpdateBooking, handleDeleteBooking,
} from './bookings.js';
import {
  handleListConversations, handleListMessages as handleConversationMessages, handleSendMessage,
} from './conversations.js';
import { handleListCalendar, handleCreateAppointment } from './calendar.js';
import { handleBilling } from './billing.js';
import { handleListForms, handleListWorkflows, handleAddToWorkflow } from './forms.js';
import { handleCrmLinks } from './crm.js';
import { handleDashboard, handleProduction } from './reports.js';
import {
  handleListAdvisors, handleSetAdvisorStatus, handleSetAdvisorGhl, handleHealth, handleTestEmail,
} from './admin.js';
import { purgeExpiredSessions } from './db.js';

// Pages any visitor may reach.
const PUBLIC_PAGES = new Set([
  '/', '/index.html',
  '/login', '/login.html',
  '/signup', '/signup.html',
  '/forgot-password', '/forgot-password.html',
  '/reset-password', '/reset-password.html',
  '/pending', '/pending.html',
]);

// Extension-less page paths mapped to the file that serves them.
const PAGE_FILES = {
  '/': '/index.html',
  '/login': '/login.html',
  '/signup': '/signup.html',
  '/forgot-password': '/forgot-password.html',
  '/reset-password': '/reset-password.html',
  '/pending': '/pending.html',
  '/app': '/app/index.html',
  '/app/': '/app/index.html',
  '/app/leads': '/app/leads.html',
  '/app/contact': '/app/contact.html',
  '/app/inbox': '/app/inbox.html',
  '/app/calendar': '/app/calendar.html',
  '/app/billing': '/app/billing.html',
  '/app/forms': '/app/forms.html',
  '/app/crm': '/app/crm.html',
  '/app/pipeline': '/app/pipeline.html',
  '/app/bookings': '/app/bookings.html',
  '/app/reports': '/app/reports.html',
  '/app/settings': '/app/settings.html',
  '/admin': '/admin/index.html',
  '/admin/': '/admin/index.html',
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (e) {
      console.error('unhandled', e);
      return json({ error: 'Something went wrong.' }, 500);
    }
  },

  // Housekeeping: drop expired sessions so the table does not grow forever.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredSessions(env).catch((e) => console.error('purge', e)));
  },
};

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const method = request.method.toUpperCase();

  if (path.startsWith('/api/')) return routeApi(request, env, path, method);

  // Everything else is a page or a static file.
  return routePage(request, env, path);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function routeApi(request, env, path, method) {
  // /api/leads/<id>/notes and /api/leads/<id>
  const leadMatch = path.match(/^\/api\/leads\/([^/]+)(\/notes)?$/);
  const detailMatch = path.match(/^\/api\/leads\/([^/]+)\/detail$/);
  const taskMatch = path.match(/^\/api\/leads\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  const wfMatch = path.match(/^\/api\/leads\/([^/]+)\/workflow$/);
  const oppMatch = path.match(/^\/api\/opportunities\/([^/]+)$/);
  const bookingMatch = path.match(/^\/api\/bookings\/([^/]+)$/);
  const convoMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  const advisorMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)\/(status|ghl)$/);

  // ---- auth -------------------------------------------------------------
  if (path === '/api/auth/signup' && method === 'POST') return handleSignup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/forgot' && method === 'POST') return handleForgot(request, env);
  if (path === '/api/auth/reset' && method === 'POST') return handleReset(request, env);
  if (path === '/api/auth/password' && method === 'POST') return handleChangePassword(request, env);
  if (path === '/api/auth/profile' && method === 'PUT') return handleUpdateProfile(request, env);

  // ---- leads ------------------------------------------------------------
  if (path === '/api/leads' && method === 'GET') return handleListLeads(request, env);
  if (path === '/api/leads' && method === 'POST') return handleCreateLead(request, env);
  if (wfMatch && method === 'POST') {
    return handleAddToWorkflow(request, env, decodeURIComponent(wfMatch[1]));
  }
  if (detailMatch && method === 'GET') {
    return handleContactDetail(request, env, decodeURIComponent(detailMatch[1]));
  }
  if (taskMatch && !taskMatch[2] && method === 'POST') {
    return handleCreateTask(request, env, decodeURIComponent(taskMatch[1]));
  }
  if (taskMatch && taskMatch[2] && method === 'PUT') {
    return handleToggleTask(request, env,
      decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]));
  }
  if (leadMatch && leadMatch[2] === '/notes' && method === 'POST') {
    return handleCreateLeadNote(request, env, decodeURIComponent(leadMatch[1]));
  }
  if (leadMatch && !leadMatch[2] && method === 'GET') {
    return handleGetLead(request, env, decodeURIComponent(leadMatch[1]));
  }
  if (leadMatch && !leadMatch[2] && method === 'PUT') {
    return handleUpdateLead(request, env, decodeURIComponent(leadMatch[1]));
  }

  // ---- pipeline ---------------------------------------------------------
  if (path === '/api/pipelines' && method === 'GET') return handleListPipelines(request, env);
  if (path === '/api/opportunities' && method === 'GET') return handleListOpportunities(request, env);
  if (path === '/api/opportunities' && method === 'POST') return handleCreateOpportunity(request, env);
  if (oppMatch && method === 'PUT') {
    return handleUpdateOpportunity(request, env, decodeURIComponent(oppMatch[1]));
  }

  // ---- bookings ---------------------------------------------------------
  if (path === '/api/bookings' && method === 'GET') return handleListBookings(request, env);
  if (path === '/api/bookings' && method === 'POST') return handleCreateBooking(request, env);
  if (bookingMatch && method === 'GET') return handleGetBooking(request, env, bookingMatch[1]);
  if (bookingMatch && method === 'PUT') return handleUpdateBooking(request, env, bookingMatch[1]);
  if (bookingMatch && method === 'DELETE') return handleDeleteBooking(request, env, bookingMatch[1]);

  // ---- conversations ----------------------------------------------------
  if (path === '/api/conversations' && method === 'GET') return handleListConversations(request, env);
  if (path === '/api/conversations/send' && method === 'POST') return handleSendMessage(request, env);
  if (convoMatch && method === 'GET') {
    return handleConversationMessages(request, env, decodeURIComponent(convoMatch[1]));
  }

  // ---- calendar ---------------------------------------------------------
  if (path === '/api/calendar' && method === 'GET') return handleListCalendar(request, env);
  if (path === '/api/calendar/appointments' && method === 'POST') {
    return handleCreateAppointment(request, env);
  }

  // ---- forms and workflows ----------------------------------------------
  if (path === '/api/forms' && method === 'GET') return handleListForms(request, env);
  if (path === '/api/workflows' && method === 'GET') return handleListWorkflows(request, env);
  if (path === '/api/crm/links' && method === 'GET') return handleCrmLinks(request, env);

  // ---- billing ----------------------------------------------------------
  if (path === '/api/billing' && method === 'GET') return handleBilling(request, env);

  // ---- dashboard and reports -------------------------------------------
  if (path === '/api/dashboard' && method === 'GET') return handleDashboard(request, env);
  if (path === '/api/reports/production' && method === 'GET') return handleProduction(request, env);

  // ---- admin ------------------------------------------------------------
  if (path === '/api/admin/health' && method === 'GET') return handleHealth(request, env);
  if (path === '/api/admin/test-email' && method === 'POST') return handleTestEmail(request, env);
  if (path === '/api/admin/advisors' && method === 'GET') return handleListAdvisors(request, env);
  if (advisorMatch && method === 'PUT') {
    const id = decodeURIComponent(advisorMatch[1]);
    return advisorMatch[2] === 'status'
      ? handleSetAdvisorStatus(request, env, id)
      : handleSetAdvisorGhl(request, env, id);
  }

  return notFound('No such endpoint.');
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
async function routePage(request, env, path) {
  const needsAuth = path.startsWith('/app');
  const needsAdmin = path.startsWith('/admin');

  if (needsAuth || needsAdmin) {
    const user = await getCurrentUser(request, env);

    if (!user) {
      const next = encodeURIComponent(path);
      return redirect(`/login?next=${next}`);
    }
    if (user.status === 'pending') return redirect('/pending');
    if (user.status !== 'active') return redirect('/login?error=suspended');
    if (needsAdmin && !isAdmin(user)) return redirect('/app/');
  }

  // Signed-in advisors should not sit on the sign-in pages.
  if (path === '/login' || path === '/login.html' || path === '/' || path === '/index.html') {
    const user = await getCurrentUser(request, env);
    if (user && user.status === 'active') {
      return redirect(isAdmin(user) ? '/admin/' : '/app/');
    }
  }

  return serveAsset(request, env, path);
}

async function serveAsset(request, env, path) {
  const file = PAGE_FILES[path] || path;
  const assetUrl = new URL(request.url);
  assetUrl.pathname = file;

  const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  if (res.status !== 404) return res;

  // Extension-less path that is not in the map: try <path>.html once.
  if (!/\.[a-z0-9]+$/i.test(path)) {
    assetUrl.pathname = `${path.replace(/\/$/, '')}.html`;
    const retry = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    if (retry.status !== 404) return retry;
  }

  assetUrl.pathname = '/404.html';
  const fallback = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  return new Response(fallback.body, {
    status: 404,
    headers: fallback.headers,
  });
}

export { PUBLIC_PAGES };
