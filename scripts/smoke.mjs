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

  // ------------------------------------------------------- group space ------
  step('Group space, and the option date that ends it');

  const badDate = await call(advisor, 'POST', '/api/groups', {
    name: `Bad dates ${stamp}`, departDate: isoDay(100), optionDate: isoDay(120),
  });
  check(badDate.status === 400, 'an option date after departure is refused', `status ${badDate.status}`);

  const grp = await call(advisor, 'POST', '/api/groups', {
    name: `Islander New Year ${stamp}`, vendor: 'Margaritaville at Sea', groupCode: '4668',
    departDate: isoDay(120), returnDate: isoDay(126), optionDate: isoDay(30), cabinsHeld: 20,
  });
  const groupId = grp.data?.group?.id;
  check(grp.status === 201 && groupId, 'a group is opened', `status ${grp.status}`);
  if (groupId) cleanup('the group', () => call(advisor, 'DELETE', `/api/groups/${groupId}`));
  check(grp.data?.group?.cabins_sold === 0, 'holding cabins none of which are sold yet',
    grp.data?.group?.cabins_sold);

  const inGroup = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Group Client ${stamp}`, supplier: 'Margaritaville at Sea',
    departDate: isoDay(120), gross: '2400', status: 'booked', groupId,
  });
  const inGroupId = inGroup.data?.booking?.id;
  check(inGroup.data?.booking?.group_id === groupId,
    'a reservation sold from the block records the group', inGroup.data?.booking?.group_id);
  if (inGroupId) cleanup('the group reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${inGroupId}`));

  // Sold is counted from the reservations rather than stored, so it cannot
  // drift away from the truth.
  const groupDetail = await call(advisor, 'GET', `/api/groups/${groupId}`);
  check(groupDetail.data?.group?.cabins_sold === 1, 'and the sold count follows from it',
    groupDetail.data?.group?.cabins_sold);
  check((groupDetail.data?.bookings || []).some((b) => b.id === inGroupId),
    'with the reservation listed in the block');

  const groupList = await call(advisor, 'GET', '/api/groups?status=open');
  check(groupList.data?.stats?.held >= 20 && groupList.data.stats.sold >= 1,
    'held and sold roll up across groups', JSON.stringify(groupList.data?.stats));

  const ownerEdit = await call(admin, 'PUT', `/api/groups/${groupId}`, { name: 'Not yours' });
  check(ownerEdit.status === 404, 'an owner cannot rewrite an associate\'s group',
    `status ${ownerEdit.status}`);

  // A block is a commercial arrangement; the trips sold out of it are real
  // holidays people have paid for. Deleting one must not delete the other.
  // Checked here rather than after cleanup, where the reservation has already
  // been removed and a 404 would look like a pass for the wrong reason.
  await call(advisor, 'DELETE', `/api/groups/${groupId}`);
  const survivor = await call(advisor, 'GET', `/api/bookings/${inGroupId}`);
  check(survivor.status === 200 && !survivor.data.booking.group_id,
    'deleting a group keeps its reservations and clears the link',
    `status ${survivor.status}, group ${survivor.data?.booking?.group_id}`);

  // ------------------------------------------------------------- tasks ------
  step('The task list');

  const t1 = await call(advisor, 'POST', '/api/tasks',
    { title: `Ring the client ${stamp}`, dueDate: isoDay(-2), priority: 'high' });
  const t2 = await call(advisor, 'POST', '/api/tasks', { title: `Send documents ${stamp}`, dueDate: isoDay(3) });
  const t3 = await call(advisor, 'POST', '/api/tasks', { title: `Someday idea ${stamp}` });
  const taskId = t1.data?.task?.id;
  check(t1.status === 201 && taskId, 'a task is created', `status ${t1.status}`);
  if (taskId) cleanup('the tasks', async () => {
    for (const t of [t1, t2, t3]) {
      if (t.data?.task?.id) await call(advisor, 'DELETE', `/api/tasks/${t.data.task.id}`);
    }
  });

  // oneOf falls back to the first entry of its list, so a list ordered wrongly
  // silently promotes every task. This shipped that way for about ten minutes.
  check(t2.data?.task?.priority === 'normal',
    'a task with no priority given is normal, not high', t2.data?.task?.priority);

  const open = await call(advisor, 'GET', '/api/tasks?state=open');
  check(open.data?.counts?.overdue >= 1 && open.data.counts.open >= 3,
    'overdue and open are counted', JSON.stringify(open.data?.counts));
  const order = (open.data?.tasks || []).map((t) => t.title);
  check(order.indexOf(`Ring the client ${stamp}`) < order.indexOf(`Someday idea ${stamp}`),
    'dated tasks sort above undated ones');

  const ticked = await call(advisor, 'PUT', `/api/tasks/${taskId}`, { done: true });
  check(ticked.data?.task?.done_at, 'ticking one off records when');
  const stillOpen = await call(advisor, 'GET', '/api/tasks?state=open');
  check(!(stillOpen.data?.tasks || []).some((t) => t.id === taskId),
    'and it leaves the open list');
  const done = await call(advisor, 'GET', '/api/tasks?state=done');
  check((done.data?.tasks || []).some((t) => t.id === taskId), 'but is still on the done list');

  const notMine = await call(admin, 'PUT', `/api/tasks/${taskId}`, { done: false });
  check(notMine.status === 404, 'an owner cannot tick off an associate\'s task', `status ${notMine.status}`);
  const ownerSees = await call(admin, 'GET', '/api/tasks?state=all');
  check((ownerSees.data?.tasks || []).some((t) => t.id === taskId),
    'though they can see it in the agency list');

  const foreign = await call(advisor, 'POST', '/api/tasks',
    { title: 'Linked to someone else', bookingId: ownerBookingId });
  check(foreign.status === 400,
    'and a task cannot be linked to another advisor\'s reservation', `status ${foreign.status}`);

  // ---------------------------------------------------- client credits ------
  step('Credits a client holds with a vendor');

  const badExpiry = await call(advisor, 'POST', '/api/credits', {
    clientName: 'Backwards', amount: '100', issuedOn: isoDay(0), expiresOn: isoDay(-10),
  });
  check(badExpiry.status === 400, 'an expiry before the issue date is refused',
    `status ${badExpiry.status}`);

  const cr = await call(advisor, 'POST', '/api/credits', {
    clientName: `Credit Client ${stamp}`, vendor: 'Oceania Cruises', kind: 'credit',
    amount: '250.00', reference: `FCC-${stamp}`, issuedOn: isoDay(-100), expiresOn: isoDay(40),
  });
  const creditId = cr.data?.credit?.id;
  check(cr.status === 201 && cr.data?.credit?.amount_cents === 25000,
    'a credit is recorded in cents', cr.data?.credit?.amount_cents);
  if (creditId) cleanup('the credit', () => call(advisor, 'DELETE', `/api/credits/${creditId}`));

  const lapsed = await call(advisor, 'POST', '/api/credits', {
    clientName: `Lapsed Client ${stamp}`, amount: '75', expiresOn: isoDay(-5),
  });
  if (lapsed.data?.credit?.id) cleanup('the lapsed credit', () =>
    call(advisor, 'DELETE', `/api/credits/${lapsed.data.credit.id}`));

  const creditList = await call(advisor, 'GET', '/api/credits?state=open');
  const cs = creditList.data?.stats || {};
  check(cs.expiringCents >= 25000, 'one expiring inside 90 days is counted', cs.expiringCents);
  check(cs.lapsedCents >= 7500, 'and one already past its date is reported, not hidden', cs.lapsedCents);

  // Marking it used takes it out of the money at risk without deleting the
  // record, which is the difference between a credit that was spent and one
  // that was never there.
  await call(advisor, 'PUT', `/api/credits/${creditId}`, {
    clientName: `Credit Client ${stamp}`, amount: '250.00', expiresOn: isoDay(40), usedOn: isoDay(-1),
  });
  const afterUse = await call(advisor, 'GET', '/api/credits?state=open');
  check(!(afterUse.data?.credits || []).some((c) => c.id === creditId),
    'marking one used takes it off the unused list');
  const usedList = await call(advisor, 'GET', '/api/credits?state=used');
  check((usedList.data?.credits || []).some((c) => c.id === creditId),
    'but keeps it on the record');

  const ownerCredit = await call(admin, 'PUT', `/api/credits/${creditId}`, {
    clientName: 'Not yours', amount: '1',
  });
  check(ownerCredit.status === 404, 'an owner cannot rewrite an associate\'s credit',
    `status ${ownerCredit.status}`);

  // ------------------------------------------------------ worth a call ------
  step('Clients worth ringing');

  const past = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Lapsed Traveller ${stamp}`, supplier: 'Celebrity Cruises',
    departDate: isoDay(-400), returnDate: isoDay(-393), gross: '3200', status: 'travelled',
  });
  if (past.data?.booking?.id) cleanup('the past reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${past.data.booking.id}`));

  let callList = await call(advisor, 'GET', '/api/dashboard');
  check((callList.data?.rebook || []).some((r) => r.client_name === `Lapsed Traveller ${stamp}`),
    'someone who travelled and has nothing booked is worth a call');

  // The whole point of the query: booking them again takes them off the list.
  const rebooked = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Lapsed Traveller ${stamp}`, supplier: 'Celebrity Cruises',
    departDate: isoDay(90), gross: '4000', status: 'booked',
  });
  if (rebooked.data?.booking?.id) cleanup('the rebooking', () =>
    call(advisor, 'DELETE', `/api/bookings/${rebooked.data.booking.id}`));

  callList = await call(advisor, 'GET', '/api/dashboard');
  check(!(callList.data?.rebook || []).some((r) => r.client_name === `Lapsed Traveller ${stamp}`),
    'and booking them again takes them off the list');

  // ----------------------------------------------------------- calendar -----
  step('A month of everything with a date on it');

  const monthOf = (iso) => iso.slice(0, 7);
  const cal = await call(advisor, 'GET', `/api/month?month=${monthOf(isoDay(90))}`);
  check(cal.status === 200 && cal.data?.month === monthOf(isoDay(90)),
    'the month asked for is the month returned', cal.data?.month);
  check(cal.data?.from?.endsWith('-01') && cal.data?.to > cal.data?.from,
    'spanning that whole month', `${cal.data?.from} to ${cal.data?.to}`);

  const kinds = new Set((cal.data?.events || []).map((e) => e.kind));
  check(kinds.size > 0, 'with events on it', [...kinds].join(', '));
  check((cal.data?.events || []).every((e) => e.date >= cal.data.from && e.date <= cal.data.to),
    'and nothing outside the month');

  // A month is a bounded window, so a bad one should be corrected rather than
  // handed to the database.
  const junk = await call(advisor, 'GET', '/api/month?month=not-a-month');
  check(junk.status === 200 && /^\d{4}-\d{2}$/.test(junk.data?.month || ''),
    'a nonsense month falls back to this one', junk.data?.month);

  // Same boundary as everywhere else.
  const ownerMonth = await call(admin, 'GET', `/api/month?month=${monthOf(isoDay(210))}`);
  const advisorMonth = await call(advisor, 'GET', `/api/month?month=${monthOf(isoDay(210))}`);
  check(ownerMonth.data.events.length >= advisorMonth.data.events.length,
    'an owner sees at least what the associate sees',
    `${ownerMonth.data.events.length} vs ${advisorMonth.data.events.length}`);

  // ------------------------------------------------- dashboard layout ------
  step('The dashboard remembers how you arranged it');

  const fresh = await call(advisor, 'GET', '/api/prefs/dashboard');
  const panelIds = (fresh.data?.panels || []).map((p) => p.id);
  check(fresh.status === 200 && panelIds.length >= 6,
    'a new advisor gets the default layout', `${panelIds.length} panel(s)`);
  check((fresh.data?.layout?.widgets || []).length === panelIds.length,
    'covering every panel', `${(fresh.data?.layout?.widgets || []).length} in layout`);

  const reordered = [...fresh.data.layout.widgets].reverse();
  reordered[0].hidden = true;
  const saved = await call(advisor, 'PUT', '/api/prefs/dashboard', {
    layout: { widgets: reordered, links: [{ label: 'Vendor portal', href: 'https://example.com' }] },
  });
  check(saved.data?.layout?.widgets?.[0]?.id === reordered[0].id && saved.data.layout.widgets[0].hidden,
    'a reordered layout with a hidden panel saves');

  const reread = await call(advisor, 'GET', '/api/prefs/dashboard');
  check(reread.data?.layout?.widgets?.[0]?.id === reordered[0].id,
    'and comes back the same on the next visit');
  check(reread.data?.layout?.links?.[0]?.href === 'https://example.com',
    'along with their quick links');

  // A layout is user supplied data that is later rendered back into a page,
  // so what the server does with a hostile one matters more than what the
  // form does. The form's checks are a message; these are the guarantee.
  const hostile = await call(advisor, 'PUT', '/api/prefs/dashboard', {
    layout: {
      widgets: [{ id: 'notices' }, { id: 'made-up-panel' }, { id: 'notices' }],
      links: [
        { label: 'x', href: 'javascript:alert(1)' },
        { label: 'y', href: 'data:text/html,hi' },
        { label: 'fine', href: 'https://good.example' },
      ],
    },
  });
  const gotIds = (hostile.data?.layout?.widgets || []).map((w) => w.id);
  check(!gotIds.includes('made-up-panel'), 'an unknown panel id is dropped', gotIds.join(', '));
  check(gotIds.filter((x) => x === 'notices').length === 1, 'a duplicate is collapsed');
  check(gotIds.length === panelIds.length, 'and the missing panels are put back');
  const gotLinks = hostile.data?.layout?.links || [];
  check(gotLinks.length === 1 && gotLinks[0].href === 'https://good.example',
    'only http and https links survive', JSON.stringify(gotLinks));

  const reset = await call(advisor, 'DELETE', '/api/prefs/dashboard');
  check((reset.data?.layout?.widgets || []).length === panelIds.length &&
    !(reset.data.layout.widgets[0] || {}).hidden,
    'and reset puts the default back');

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
