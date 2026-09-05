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
  handleListBookings, handleGetBooking, handleBookingRecord, handleCreateBooking,
  handleUpdateBooking, handleDeleteBooking,
} from './bookings.js';
import {
  handleListConversations, handleListMessages as handleConversationMessages, handleSendMessage,
} from './conversations.js';
import { handleListCalendar, handleCreateAppointment } from './calendar.js';
import { handleBilling, handleCreateInvoice, handleSendInvoice } from './billing.js';
import {
  handlePayments, handleCreatePayment, handleUpdatePayment,
  handleMarkPaid, handleDeletePayment, handleGenerateSchedule, handleSetBookingStatus,
} from './payments.js';
import { handleListForms, handleListWorkflows, handleAddToWorkflow } from './forms.js';
import { handleCrmLinks } from './crm.js';
import {
  handleListForms as handleListOwnForms, handleGetForm, handleSaveForm, handleDeleteForm,
} from './formbuilder.js';
import { renderPublicForm, handlePublicSubmit } from './publicform.js';
import { handleSearch } from './search.js';
import { handleGetLayout, handleSaveLayout, handleResetLayout } from './prefs.js';
// Aliased: leads.js already exports handleCreateTask for the CRM's own
// contact tasks, which are a different thing from an advisor's working list.
import {
  handleListTasks as handleListMyTasks,
  handleCreateTask as handleCreateMyTask,
  handleUpdateTask as handleUpdateMyTask,
  handleDeleteTask as handleDeleteMyTask,
} from './tasks.js';
import {
  handleListGroups, handleGetGroup, handleCreateGroup, handleUpdateGroup, handleDeleteGroup,
} from './groups.js';
import {
  handleListCredits, handleCreateCredit, handleUpdateCredit, handleDeleteCredit,
} from './credits.js';
import { handleGetGoals, handleSaveGoals } from './goals.js';
import {
  handleListAutomations, handleGetAutomation, handleSaveAutomation,
  handleDeleteAutomation, handleRunAutomations, processDueRuns, scanTimeTriggers, purgeOldRuns,
} from './automations.js';
import {
  handleMarketing, handleCatalog, handleLibrary, handleAccount, handleSurveys,
  handleCreateSocialPost, handleCreateProduct, handleCreateAccountItem,
} from './library.js';
import { handleDashboard, handleProduction, handleMonth } from './reports.js';
import {
  handleListAdvisors, handleSetAdvisorStatus, handleSetAdvisorGhl, handleHealth, handleTestEmail,
  handleSyncStatus, handleRunSync,
} from './admin.js';
import { purgeExpiredSessions } from './db.js';
import { runSync } from './sync.js';
import { locationFor } from './ghl.js';

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
  '/app/payments': '/app/payments.html',
  '/app/forms': '/app/forms.html',
  '/app/formbuilder': '/app/formbuilder.html',
  '/app/automations': '/app/automations.html',
  '/app/crm': '/app/crm.html',
  '/app/marketing': '/app/marketing.html',
  '/app/catalog': '/app/catalog.html',
  '/app/library': '/app/library.html',
  '/app/account': '/app/account.html',
  '/app/pipeline': '/app/pipeline.html',
  '/app/tasks': '/app/tasks.html',
  '/app/groups': '/app/groups.html',
  '/app/credits': '/app/credits.html',
  '/app/goals': '/app/goals.html',
  '/app/reservations': '/app/reservations.html',
  '/app/reservation': '/app/reservation.html',
  '/app/bookings': '/app/reservations.html',
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

  // Keeps the local CRM copy current and drops expired sessions. Both are
  // resumable or cheap, so an idle run costs almost nothing.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpiredSessions(env).catch((e) => console.error('purge', e)));
    ctx.waitUntil(purgeOldRuns(env).catch((e) => console.error('purge runs', e)));
    ctx.waitUntil(
      runSync(env, locationFor(env, null)).catch((e) => console.error('sync', e))
    );
    // Look for time based triggers, then advance whatever is due. Order
    // matters: scanning first means a payment that just came into range is
    // acted on in the same pass rather than waiting five more minutes.
    ctx.waitUntil(
      scanTimeTriggers(env, locationFor(env, null))
        .catch((e) => console.error('time triggers', e))
        .then(() => processDueRuns(env))
        .catch((e) => console.error('automations', e))
    );
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
  const recordMatch = path.match(/^\/api\/bookings\/([^/]+)\/record$/);
  const convoMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  const invoiceSendMatch = path.match(/^\/api\/billing\/invoices\/([^/]+)\/send$/);
  const ownFormMatch = path.match(/^\/api\/myforms\/([^/]+)$/);
  const publicFormMatch = path.match(/^\/api\/public\/forms\/([^/]+)$/);
  // Excludes /run, which is an action rather than an automation id.
  const accountItemMatch = path.match(/^\/api\/account\/(tags|custom-values|custom-fields)$/);
  const autoMatch = path.match(/^\/api\/automations\/(?!run$)([^/]+)$/);
  const payMatch = path.match(/^\/api\/payments\/([^/]+)$/);
  const payPaidMatch = path.match(/^\/api\/payments\/([^/]+)\/paid$/);
  const scheduleMatch = path.match(/^\/api\/bookings\/([^/]+)\/schedule$/);
  const bookingStatusMatch = path.match(/^\/api\/bookings\/([^/]+)\/status$/);
  const advisorMatch = path.match(/^\/api\/admin\/advisors\/([^/]+)\/(status|ghl)$/);
  const myTaskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  const creditMatch = path.match(/^\/api\/credits\/([^/]+)$/);

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
  if (recordMatch && method === 'GET') return handleBookingRecord(request, env, recordMatch[1]);
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

  // Our own forms, built and hosted here.
  if (path === '/api/myforms' && method === 'GET') return handleListOwnForms(request, env);
  if (path === '/api/myforms' && method === 'POST') return handleSaveForm(request, env, null);
  if (ownFormMatch && method === 'GET') return handleGetForm(request, env, ownFormMatch[1]);
  if (ownFormMatch && method === 'PUT') return handleSaveForm(request, env, ownFormMatch[1]);
  if (ownFormMatch && method === 'DELETE') return handleDeleteForm(request, env, ownFormMatch[1]);

  // Automations.
  if (path === '/api/automations' && method === 'GET') return handleListAutomations(request, env);
  if (path === '/api/automations' && method === 'POST') return handleSaveAutomation(request, env, null);
  if (path === '/api/automations/run' && method === 'POST') return handleRunAutomations(request, env);
  if (autoMatch && method === 'GET') return handleGetAutomation(request, env, autoMatch[1]);
  if (autoMatch && method === 'PUT') return handleSaveAutomation(request, env, autoMatch[1]);
  if (autoMatch && method === 'DELETE') return handleDeleteAutomation(request, env, autoMatch[1]);

  // Public submission endpoint for a hosted form. Unauthenticated by design.
  if (publicFormMatch && method === 'POST') {
    return handlePublicSubmit(request, env, decodeURIComponent(publicFormMatch[1]));
  }
  if (path === '/api/surveys' && method === 'GET') return handleSurveys(request, env);
  if (path === '/api/marketing' && method === 'GET') return handleMarketing(request, env);
  if (path === '/api/catalog' && method === 'GET') return handleCatalog(request, env);
  if (path === '/api/library' && method === 'GET') return handleLibrary(request, env);
  if (path === '/api/account' && method === 'GET') return handleAccount(request, env);
  if (path === '/api/marketing/social' && method === 'POST') return handleCreateSocialPost(request, env);
  if (path === '/api/catalog/products' && method === 'POST') return handleCreateProduct(request, env);
  if (accountItemMatch && method === 'POST') {
    return handleCreateAccountItem(request, env, accountItemMatch[1]);
  }

  // ---- payments ---------------------------------------------------------
  if (path === '/api/payments' && method === 'GET') return handlePayments(request, env);
  if (path === '/api/payments' && method === 'POST') return handleCreatePayment(request, env);
  if (payPaidMatch && method === 'POST') return handleMarkPaid(request, env, payPaidMatch[1]);
  if (payMatch && method === 'PUT') return handleUpdatePayment(request, env, payMatch[1]);
  if (payMatch && method === 'DELETE') return handleDeletePayment(request, env, payMatch[1]);
  if (scheduleMatch && method === 'POST') {
    return handleGenerateSchedule(request, env, scheduleMatch[1]);
  }
  if (bookingStatusMatch && method === 'POST') {
    return handleSetBookingStatus(request, env, bookingStatusMatch[1]);
  }

  // ---- billing ----------------------------------------------------------
  if (path === '/api/billing' && method === 'GET') return handleBilling(request, env);
  if (path === '/api/billing/invoices' && method === 'POST') return handleCreateInvoice(request, env);
  if (invoiceSendMatch && method === 'POST') {
    return handleSendInvoice(request, env, decodeURIComponent(invoiceSendMatch[1]));
  }

  // ---- dashboard and reports -------------------------------------------
  if (path === '/api/search' && method === 'GET') return handleSearch(request, env);

  // Tasks: the advisor's own working list, not the CRM's.
  if (path === '/api/tasks' && method === 'GET') return handleListMyTasks(request, env);
  if (path === '/api/tasks' && method === 'POST') return handleCreateMyTask(request, env);
  if (myTaskMatch && method === 'PUT') return handleUpdateMyTask(request, env, myTaskMatch[1]);
  if (myTaskMatch && method === 'DELETE') return handleDeleteMyTask(request, env, myTaskMatch[1]);

  // Group space: cabins held by a vendor before anybody has booked them.
  if (path === '/api/groups' && method === 'GET') return handleListGroups(request, env);
  if (path === '/api/groups' && method === 'POST') return handleCreateGroup(request, env);
  if (groupMatch && method === 'GET') return handleGetGroup(request, env, groupMatch[1]);
  if (groupMatch && method === 'PUT') return handleUpdateGroup(request, env, groupMatch[1]);
  if (groupMatch && method === 'DELETE') return handleDeleteGroup(request, env, groupMatch[1]);

  // Credits a client already holds with a vendor, and when they lapse.
  if (path === '/api/credits' && method === 'GET') return handleListCredits(request, env);
  if (path === '/api/credits' && method === 'POST') return handleCreateCredit(request, env);
  if (creditMatch && method === 'PUT') return handleUpdateCredit(request, env, creditMatch[1]);
  if (creditMatch && method === 'DELETE') return handleDeleteCredit(request, env, creditMatch[1]);
  if (path === '/api/prefs/dashboard' && method === 'GET') return handleGetLayout(request, env);
  if (path === '/api/prefs/dashboard' && method === 'PUT') return handleSaveLayout(request, env);
  if (path === '/api/prefs/dashboard' && method === 'DELETE') return handleResetLayout(request, env);
  if (path === '/api/dashboard' && method === 'GET') return handleDashboard(request, env);
  if (path === '/api/month' && method === 'GET') return handleMonth(request, env);
  if (path === '/api/goals' && method === 'GET') return handleGetGoals(request, env);
  if (path === '/api/goals' && method === 'PUT') return handleSaveGoals(request, env);
  if (path === '/api/reports/production' && method === 'GET') return handleProduction(request, env);

  // ---- admin ------------------------------------------------------------
  if (path === '/api/admin/health' && method === 'GET') return handleHealth(request, env);
  if (path === '/api/admin/test-email' && method === 'POST') return handleTestEmail(request, env);
  if (path === '/api/admin/sync' && method === 'GET') return handleSyncStatus(request, env);
  if (path === '/api/admin/sync' && method === 'POST') return handleRunSync(request, env);
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
  // Hosted forms are public: no session, no gate. They are how leads arrive.
  const hosted = path.match(/^\/f\/([^/]+)\/?$/);
  if (hosted) return renderPublicForm(request, env, decodeURIComponent(hosted[1]));

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
