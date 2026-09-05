/**
 * Smoke test: drive the flows that have never run in production.
 *
 * The contract checker asks whether a page reads fields the API returns. It
 * says nothing about whether a sequence of requests does the right thing, and
 * three of this portal's paths had never been executed end to end at all:
 *
 *   signup -> pending -> admin approval -> first sign in
 *   a hosted form submission arriving as a lead
 *   an automation firing from that submission and running to completion
 *
 * Each is only exercised by a real person doing a real thing weeks apart, so a
 * regression in one would sit undetected until it cost someone a lead. This
 * runs the lot against a local dev server in a few seconds.
 *
 * Usage: node scripts/smoke.mjs [baseUrl] [adminEmail] [adminPassword]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN_EMAIL = process.argv[3] || 'local@test.dev';
const ADMIN_PASSWORD = process.argv[4] || 'local-test-12345';

const stamp = Date.now().toString(36);
const ADVISOR_EMAIL = `smoke-${stamp}@test.dev`;
const ADVISOR_PASSWORD = 'smoke-test-12345';

let failures = 0;
let checks = 0;

function ok(label) { checks++; console.log(`  ok    ${label}`); }
function fail(label, detail) {
  checks++; failures++;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}
function check(condition, label, detail) {
  condition ? ok(label) : fail(label, detail);
  return Boolean(condition);
}
function step(name) { console.log(`\n${name}`); }

/** A cookie jar, because sessions are the thing under test. */
function jar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      // Workers send one Set-Cookie per header; getSetCookie keeps them apart.
      const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

async function call(cookieJar, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookieJar && cookieJar.header() ? { cookie: cookieJar.header() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  if (cookieJar) cookieJar.absorb(res);
  let data = null;
  try { data = await res.json(); } catch { /* not every response is JSON */ }
  return { status: res.status, data };
}

const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Anything created gets registered here immediately. An earlier version tidied
// up only on the happy path, so a run that bailed half way left a form behind,
// and that stray form went on to confuse the contract checker on the next run.
// Test data that outlives its test is worse than no test data.
const cleanups = [];
function cleanup(label, fn) { cleanups.push({ label, fn }); }
async function runCleanups() {
  // Drained, not iterated, so the happy path can tidy up and assert on the
  // result while the finally below stays a no-op rather than deleting twice.
  while (cleanups.length) {
    const { label, fn } = cleanups.pop();
    try { await fn(); } catch (e) { console.log(`  note  could not clean up ${label}: ${e.message}`); }
  }
}
class Bail extends Error {}

// Both live at module scope so the finally below can still reach them.
const admin = jar();
let advisorId = null;

async function main() {
  console.log(`Smoke test against ${BASE}`);

  // ---------------------------------------------------------------- admin --
  step('Admin signs in');
  const login = await call(admin, 'POST', '/api/auth/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!check(login.status === 200, 'admin signs in', `status ${login.status}`)) {
    throw new Bail('Cannot continue without an admin session. Is the dev server seeded?');
  }

  // ------------------------------------------------- signup and approval --
  step('A new advisor signs up and waits for approval');
  const signup = await call(null, 'POST', '/api/auth/signup', {
    email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD,
    firstName: 'Smoke', lastName: 'Tester', agencyName: 'Smoke Travel',
  });
  check(signup.status === 200 && signup.data?.status === 'pending',
    'signup returns pending', JSON.stringify(signup.data));

  const advisor = jar();
  const blocked = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(blocked.status === 403 && blocked.data?.status === 'pending',
    'a pending advisor cannot sign in', `status ${blocked.status}`);

  const list = await call(admin, 'GET', '/api/admin/advisors');
  const created = (list.data?.users || []).find((a) => a.email === ADVISOR_EMAIL);
  if (!check(created, 'the signup shows up for the admin')) throw new Bail('No advisor to approve.');
  // Deliberately not registered with the other cleanups: suspending the
  // advisor kills their session, and the checks after cleanup are made as the
  // advisor. Registered here it ran first and those checks then passed against
  // 401 bodies, which is worse than not running them.
  advisorId = created.id;
  check(created.status === 'pending', 'and shows up as pending', created.status);

  const approve = await call(admin, 'PUT', `/api/admin/advisors/${created.id}/status`,
    { status: 'active' });
  check(approve.status === 200, 'admin approves them', `status ${approve.status}`);

  const signedIn = await call(advisor, 'POST', '/api/auth/login',
    { email: ADVISOR_EMAIL, password: ADVISOR_PASSWORD });
  check(signedIn.status === 200, 'the advisor can now sign in', `status ${signedIn.status}`);
  const me = await call(advisor, 'GET', '/api/auth/me');
  check(me.data?.user?.email === ADVISOR_EMAIL, 'and the session is theirs', me.data?.user?.email);

  // ------------------------------------------ reservation and its schedule --
  step('A reservation, and the schedule built from it');
  const res = await call(advisor, 'POST', '/api/bookings', {
    clientName: 'Smoke Client', supplier: 'Carnival', productName: 'Western Caribbean',
    productType: 'cruise', confirmationNumber: `SMK${stamp}`,
    departDate: isoDay(120), returnDate: isoDay(127),
    depositDue: isoDay(5), finalPaymentDue: isoDay(60),
    gross: '5000', deposit: '500', commission: '600', status: 'booked',
  });
  const bookingId = res.data?.booking?.id;
  if (!check(res.status === 201 && bookingId, 'reservation created', `status ${res.status}`)) {
    throw new Bail('No reservation to schedule.');
  }
  cleanup('the reservation', () => call(advisor, 'DELETE', `/api/bookings/${bookingId}`));
  check(res.data.booking.deposit_cents === 50000,
    'the deposit is stored and read back', res.data.booking.deposit_cents);

  const sched = await call(advisor, 'POST', `/api/bookings/${bookingId}/schedule`, {});
  const rows = sched.data?.created || [];
  check(sched.status === 201, 'schedule built', `status ${sched.status}`);

  const deposit = rows.find((p) => p.kind === 'deposit');
  const hardFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'hard');
  const softFinal = rows.find((p) => p.kind === 'final' && p.payment_class === 'soft');

  check(deposit?.payment_class === 'hard' && deposit?.amount_cents === 50000,
    'a hard deposit for the deposit amount', JSON.stringify(deposit));
  check(hardFinal?.amount_cents === 450000 && hardFinal?.due_date === isoDay(60),
    'a hard balance on the vendor date, net of the deposit', JSON.stringify(hardFinal));
  check(softFinal?.amount_cents === 450000 && softFinal?.due_date === isoDay(53),
    'a soft reminder one week earlier', JSON.stringify(softFinal));

  const again = await call(advisor, 'POST', `/api/bookings/${bookingId}/schedule`, {});
  check((again.data?.created || []).length === 0,
    'building it twice does not duplicate the schedule', JSON.stringify(again.data?.created));

  // The dashboard is the thing an advisor actually looks at, so check the
  // schedule reaches it rather than trusting the write.
  const dash = await call(advisor, 'GET', '/api/dashboard');
  const due = dash.data?.payStats || {};
  check(due.hardDueCents >= 50000, 'the dashboard counts the hard deadlines', due.hardDueCents);

  // ------------------------------------------------ who can see what ------
  step('An associate sees their own records; an owner sees the agency');

  // The reservation above belongs to the associate, since the whole earlier
  // section runs as them. The owner needs one of their own or "cannot see the
  // owner's records" is a check that proves nothing. An earlier draft of this
  // test compared the associate against their own reservation and reported a
  // leak that was not there.
  const ownerRes = await call(admin, 'POST', '/api/bookings', {
    clientName: `Owner Client ${stamp}`, supplier: 'Virgin Voyages',
    departDate: isoDay(210), gross: '8000', commission: '800', status: 'booked',
  });
  const ownerBookingId = ownerRes.data?.booking?.id;
  if (ownerBookingId) {
    cleanup('the owner reservation', () => call(admin, 'DELETE', `/api/bookings/${ownerBookingId}`));
  }
  check(ownerRes.status === 201 && ownerBookingId, 'the owner creates a reservation of their own');

  // Now the associate's own.
  const theirs = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Associate Client ${stamp}`, supplier: 'Royal Caribbean',
    departDate: isoDay(200), gross: '3000', commission: '300', status: 'booked',
  });
  const theirBookingId = theirs.data?.booking?.id;
  if (theirBookingId) {
    cleanup('the associate reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${theirBookingId}`));
  }
  check(theirs.status === 201 && theirBookingId, 'the associate creates a reservation');

  const mine = await call(advisor, 'GET', '/api/bookings');
  const mineIds = (mine.data?.bookings || []).map((b) => b.id);
  check(mineIds.includes(theirBookingId) && !mineIds.includes(ownerBookingId),
    'the associate sees their own reservation and not the owner\'s',
    `${mineIds.length} reservation(s) visible`);
  check(mine.data?.scope && mine.data.scope.canPick === false,
    'and is offered no advisor picker', JSON.stringify(mine.data?.scope));

  // The one that matters: an associate cannot widen their own scope by
  // editing the query string.
  const forged = await call(advisor, 'GET', `/api/bookings?advisor=${encodeURIComponent(created.id)}&advisor=all`);
  const forgedIds = (forged.data?.bookings || []).map((b) => b.id);
  check(!forgedIds.includes(ownerBookingId),
    'and cannot widen their scope with ?advisor=', `${forgedIds.length} reservation(s)`);

  const allRes = await call(admin, 'GET', '/api/bookings');
  const allIds = (allRes.data?.bookings || []).map((b) => b.id);
  check(allIds.includes(theirBookingId),
    'the owner sees the associate\'s reservation', `${allIds.length} reservation(s)`);
  const attributed = (allRes.data?.bookings || []).find((b) => b.id === theirBookingId);
  check(attributed && attributed.advisor_name,
    'attributed to whoever booked it', attributed && attributed.advisor_name);
  check(allRes.data?.scope?.all === true && allRes.data.scope.canPick === true,
    'with a picker to narrow it down', JSON.stringify(allRes.data?.scope));

  const narrowed = await call(admin, 'GET', `/api/bookings?advisor=${encodeURIComponent(created.id)}`);
  const narrowedIds = (narrowed.data?.bookings || []).map((b) => b.id);
  check(narrowedIds.includes(theirBookingId) && !narrowedIds.includes(ownerBookingId),
    'and narrowing to one advisor shows only theirs', `${narrowedIds.length} reservation(s)`);

  // Seeing is not editing. This is the distinction the code keeps by using a
  // separate scope for writes, and it is worth proving rather than assuming.
  const ownerRead = await call(admin, 'GET', `/api/bookings/${theirBookingId}`);
  check(ownerRead.status === 200, 'an owner can open an associate\'s reservation', `status ${ownerRead.status}`);
  const ownerWrite = await call(admin, 'PUT', `/api/bookings/${theirBookingId}`,
    { clientName: 'Should not apply' });
  check(ownerWrite.status === 404, 'but cannot write to it', `status ${ownerWrite.status}`);
  const stillTheirs = await call(advisor, 'GET', `/api/bookings/${theirBookingId}`);
  check(stillTheirs.data?.booking?.client_name === `Associate Client ${stamp}`,
    'and the record is unchanged', stillTheirs.data?.booking?.client_name);

  const associateRead = await call(advisor, 'GET', `/api/bookings/${ownerBookingId}`);
  check(associateRead.status === 404,
    'an associate cannot open the owner\'s reservation', `status ${associateRead.status}`);

  const report = await call(admin, 'GET', '/api/reports/production?months=12');
  const lines = report.data?.byAdvisor || [];
  check(lines.some((r) => r.user_id === created.id) && lines.length >= 2,
    'combined reporting breaks down per advisor', `${lines.length} line(s)`);

  const ownReport = await call(advisor, 'GET', '/api/reports/production?months=12');
  const ownLines = ownReport.data?.byAdvisor || [];
  check(ownLines.length === 1 && ownLines[0].user_id === created.id,
    'an associate\'s report covers only themselves', `${ownLines.length} line(s)`);

  const findAll = await call(admin, 'GET', `/api/search?q=Associate%20Client%20${stamp}`);
  check((findAll.data?.groups || []).some((g) => g.items.length),
    'the owner can find the associate\'s reservation in search');
  const findMine = await call(advisor, 'GET', `/api/search?q=Owner%20Client%20${stamp}`);
  check(!(findMine.data?.groups || []).some((g) => g.items.length),
    'and search does not leak the owner\'s records to the associate',
    JSON.stringify(findMine.data?.groups));

  // --------------------------------------------- form, submission, lead --
  step('A hosted form takes a submission');
  const formRes = await call(advisor, 'POST', '/api/myforms', {
    name: `Smoke enquiry ${stamp}`,
    headline: 'Tell us about your trip',
    fields: [
      { label: 'First name', type: 'text', required: true },
      { label: 'Last name', type: 'text' },
      { label: 'Email', type: 'email', required: true },
      { label: 'Where to?', type: 'text' },
    ],
  });
  const form = formRes.data?.form;
  if (!check(formRes.status === 201 && form?.slug, 'form created', `status ${formRes.status}`)) {
    throw new Bail('No form to submit to.');
  }
  cleanup('the form', () => call(advisor, 'DELETE', `/api/myforms/${form.id}`));

  const page = await fetch(`${BASE}/f/${form.slug}`);
  check(page.status === 200, 'its hosted page is public', `status ${page.status}`);

  // An automation on this form, so the submission has something to fire.
  const autoRes = await call(advisor, 'POST', '/api/automations', {
    name: `Smoke follow up ${stamp}`,
    triggerType: 'form.submitted',
    formId: form.id,
    steps: [{ action: 'notify_team', subject: 'New enquiry', body: 'A smoke test enquiry arrived.' }],
  });
  const automationId = autoRes.data?.automation?.id;
  check(autoRes.status === 200 && automationId, 'automation created', `status ${autoRes.status}`);
  if (automationId) {
    cleanup('the automation', () => call(advisor, 'DELETE', `/api/automations/${automationId}`));
  }

  const submit = await call(null, 'POST', `/api/public/forms/${form.slug}`, {
    first_name: 'Anna', last_name: 'Submitter',
    email: `anna-${stamp}@test.dev`, where_to: 'Cozumel',
  });
  check(submit.status === 200 || submit.status === 201,
    'the public submission is accepted', `status ${submit.status} ${JSON.stringify(submit.data)}`);

  const withSubs = await call(advisor, 'GET', `/api/myforms/${form.id}`);
  const subs = withSubs.data?.submissions || [];
  check(subs.some((s) => s.email === `anna-${stamp}@test.dev`),
    'and lands as a submission on the form', `${subs.length} submission(s)`);

  // ------------------------------------------------------- automation run --
  step('The submission drives the automation');
  let detail = await call(advisor, 'GET', `/api/automations/${automationId}`);
  check((detail.data?.runs || []).length === 1,
    'the submission started exactly one run', `${(detail.data?.runs || []).length} run(s)`);

  // Runs are rows, not in-memory jobs: something has to come along and advance
  // them. In production that is the cron; here it is this request.
  await call(advisor, 'POST', '/api/automations/run', {});
  detail = await call(advisor, 'GET', `/api/automations/${automationId}`);
  const run = (detail.data?.runs || [])[0];
  // What "advanced correctly" means depends on the environment. With email
  // configured the run should finish. Without it the send throws, and the
  // run should fail immediately with the reason on it: retrying a missing API
  // key four times leaves it sitting in `waiting`, which reads as patience
  // when it is really a broken automation nobody is being told about.
  const health = await call(admin, 'GET', '/api/admin/health');
  const mailConfigured = Boolean(health.data?.email?.resendKeyPresent);
  if (mailConfigured) {
    check(run && run.status === 'done',
      'and it runs to completion', run ? `${run.status}: ${run.last_error || ''}` : 'no run');
  } else {
    check(run && run.status === 'failed' && /RESEND_API_KEY/.test(run.last_error || ''),
      'and, with email unconfigured, it fails at once and says why',
      run ? `${run.status}: ${run.last_error || 'no error recorded'}` : 'no run');
    check(run && !run.next_run_at,
      'without scheduling a retry that cannot help', run ? `retry at ${run.next_run_at}` : 'no run');
  }
  check((detail.data?.logs || []).length >= 1,
    'leaving a log of what it did', `${(detail.data?.logs || []).length} log line(s)`);

  // ---------------------------------------------------------------- tidy --
  step('Clean up');
  await runCleanups();

  // Both of these assert an absence, so they have to prove the request worked
  // first. An error body has no payments in it either.
  const gone = await call(advisor, 'GET', '/api/payments?state=all');
  check(gone.status === 200 && Array.isArray(gone.data?.payments) &&
    !gone.data.payments.some((p) => p.booking_id === bookingId),
    'deleting a reservation takes its payments with it', `status ${gone.status}`);
  const formsLeft = await call(advisor, 'GET', '/api/myforms');
  check(formsLeft.status === 200 && Array.isArray(formsLeft.data?.forms) &&
    !formsLeft.data.forms.some((f) => f.id === form.id),
    'and nothing the test created is left behind', `status ${formsLeft.status}`);
}

const started = Date.now();
main()
  .catch((e) => {
    failures += 1;
    console.log(e instanceof Bail ? `\n${e.message}` : `\nSmoke test threw: ${e && e.stack || e}`);
  })
  .finally(async () => {
    // Whatever happened above, do not leave test data in the database. The
    // suspended advisor is deliberate: suspending is the closest thing this
    // portal has to deleting an account, and an active one would keep working.
    await runCleanups();
    // Last, because it ends the advisor's session. Suspending is the closest
    // thing this portal has to deleting an account, and leaving it active
    // would keep a stale login working.
    if (advisorId) {
      await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/status`, { status: 'suspended' })
        .catch(() => {});
    }
    console.log(
      `\n${failures ? `${failures} of ${checks} checks failed.` : `All ${checks} checks passed.`}` +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
    process.exit(failures ? 1 : 0);
  });
