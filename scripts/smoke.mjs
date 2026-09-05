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

  // The soft row is a reminder to chase the same balance a week early, not a
  // second amount owed. Totalling both reported a $5,000 trip as owing $9,500
  // on every screen that summed a schedule.
  const bal = await call(advisor, 'GET', '/api/payments?state=all');
  const thisTrip = (bal.data?.balances || []).find((b) => b.id === bookingId);
  check(thisTrip && (thisTrip.paid_cents + thisTrip.scheduled_cents) <= thisTrip.gross_cents,
    'a schedule never totals more than the trip it is for',
    thisTrip && `${thisTrip.paid_cents} + ${thisTrip.scheduled_cents} vs ${thisTrip.gross_cents}`);

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

  // Pinning is not priority. Priority says how important a task is; a pin says
  // this is the one being worked on now, and it outranks any date.
  const pinned = await call(advisor, 'PUT', `/api/tasks/${t2.data.task.id}`, { pinned: true });
  check(pinned.data?.task?.pinned_at, 'a task can be pinned', pinned.data?.task?.pinned_at);
  const pinnedList = await call(advisor, 'GET', '/api/tasks?state=open');
  check(pinnedList.data?.tasks?.[0]?.id === t2.data.task.id,
    'and a pinned task sorts above a nearer due date',
    pinnedList.data?.tasks?.[0]?.title);
  check(pinnedList.data?.counts?.pinned === 1, 'and is counted', pinnedList.data?.counts?.pinned);

  const unpinned = await call(advisor, 'PUT', `/api/tasks/${t2.data.task.id}`, { pinned: false });
  check(unpinned.data?.task?.pinned_at === null, 'and unpinned again', unpinned.data?.task?.pinned_at);

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

  // ------------------------------------------------- year on year -----------
  step('This year against the same days last year');

  // Two reservations a year apart to the day, so the comparison has something
  // real on both sides rather than a zero and a shrug.
  const thisYear = await call(advisor, 'POST', '/api/bookings', {
    clientName: `YoY Now ${stamp}`, departDate: isoDay(-10), gross: '5000',
    commission: '500', status: 'travelled',
  });
  const lastYear = await call(advisor, 'POST', '/api/bookings', {
    clientName: `YoY Then ${stamp}`, departDate: isoDay(-375), gross: '2500',
    commission: '250', status: 'travelled',
  });
  for (const r of [thisYear, lastYear]) {
    if (r.data?.booking?.id) cleanup('a year on year reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const prod = await call(advisor, 'GET', '/api/reports/production?months=12');
  const dep = prod.data?.comparison?.departure?.ytd;
  check(dep && dep.now.grossCents >= 500000 && dep.prev.grossCents >= 250000,
    'both years have figures on the departure basis',
    dep && `${dep.now.grossCents} vs ${dep.prev.grossCents}`);
  check(dep && dep.prevFrom.slice(4) === dep.from.slice(4) && dep.prevTo.slice(4) === dep.to.slice(4),
    'compared over the same days, not the same length of year',
    dep && `${dep.from}..${dep.to} vs ${dep.prevFrom}..${dep.prevTo}`);
  // Checked against the totals rather than a fixed number: the database this
  // runs on has other reservations in both years, and an assertion that only
  // holds on an empty database is an assertion that will be deleted later.
  const expected = dep && dep.prev.grossCents
    ? Math.round(((dep.now.grossCents - dep.prev.grossCents) / dep.prev.grossCents) * 1000) / 10
    : null;
  check(dep && dep.change.gross === expected,
    'and the percentage change follows from the two totals',
    dep && `${dep.change.gross} vs ${expected}`);

  // created_at is unix seconds. Comparing it to an ISO date matches nothing at
  // all and looks like a quiet year rather than a broken query.
  const pur = prod.data?.comparison?.purchase?.ytd;
  check(pur && pur.now.bookings > 0,
    'the purchase basis counts reservations taken this year', pur && pur.now.bookings);

  const zero = prod.data?.comparison?.departure?.mtd;
  check(zero && (zero.prev.grossCents > 0 || zero.change.gross === null),
    'and a period with nothing to compare against says so rather than showing 0%',
    zero && JSON.stringify(zero.change));

  // ------------------------------------------------------------- catalog ----
  {
  step('The sailing catalog');

  const lines = await call(advisor, 'GET', '/api/catalog/lines');
  check(lines.status === 200, 'the catalog answers', `status ${lines.status}`);

  if (!lines.data?.ready) {
    check(true, 'no catalog imported here, so the rest is skipped');
    console.log('        (set CRUISEFEED_KEY and let the cron run to exercise this)');
  } else {
    const line = lines.data.lines[0];
    check(line && line.name, 'with cruise lines that have upcoming sailings', line && line.name);

    const ships = await call(advisor, 'GET', `/api/catalog/ships?line=${encodeURIComponent(line.name)}`);
    check((ships.data?.ships || []).length > 0, 'and ships for a line', `${ships.data?.ships?.length}`);

    const shipName = ships.data.ships[0].name;
    const dates = await call(advisor, 'GET',
      `/api/catalog/dates?ship=${encodeURIComponent(shipName)}&line=${encodeURIComponent(line.name)}`);
    const sailing = (dates.data?.dates || [])[0];
    check(sailing && sailing.depart_date && sailing.return_date,
      'and departures with a return date, which is what a pasted list never has',
      sailing && `${sailing.depart_date} to ${sailing.return_date}`);

    // The reason the catalog is here: a reservation with a departure and no
    // return, exactly as an import leaves it.
    const half = await call(advisor, 'POST', '/api/bookings', {
      clientName: `Catalog Client ${stamp}`, supplier: line.name,
      productName: sailing.ship, departDate: sailing.depart_date, status: 'booked',
    });
    const halfId = half.data?.booking?.id;
    if (halfId) cleanup('the catalog reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${halfId}`));
    check(half.data?.booking && !half.data.booking.return_date,
      'a reservation can be created with no return date');

    const suggested = await call(advisor, 'GET', '/api/catalog/suggest');
    const mine = (suggested.data?.suggestions || []).find((x) => x.id === halfId);
    check(mine && mine.fills.returnDate === sailing.return_date,
      'the catalog offers the return date it knows', mine && JSON.stringify(mine.fills));

    const applied = await call(advisor, 'POST', '/api/catalog/apply', { ids: [halfId] });
    check(applied.data?.changed === 1, 'applying it fills the gap', JSON.stringify(applied.data));
    const filled = await call(advisor, 'GET', `/api/bookings/${halfId}`);
    check(filled.data?.booking?.return_date === sailing.return_date,
      'and the reservation now carries a real return date',
      filled.data?.booking?.return_date);

    // Never overwrite. A date an advisor typed outranks anything a feed says,
    // and a tool that quietly disagrees with its user stops being used.
    await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { returnDate: isoDay(400) });
    const again = await call(advisor, 'POST', '/api/catalog/apply', { ids: [halfId] });
    const untouched = await call(advisor, 'GET', `/api/bookings/${halfId}`);
    check(untouched.data?.booking?.return_date === isoDay(400),
      'and a date already there is never overwritten',
      `${untouched.data?.booking?.return_date} after ${JSON.stringify(again.data)}`);
  }

  const adminOnly = await call(advisor, 'GET', '/api/admin/catalog');
  check(adminOnly.status === 403 || adminOnly.status === 401,
    'the import status is for owners only', `status ${adminOnly.status}`);
  const asOwner = await call(admin, 'GET', '/api/admin/catalog');
  check(asOwner.status === 200 && typeof asOwner.data?.rows === 'number',
    'who see how many rows are actually stored, not how many were sent',
    JSON.stringify({ rows: asOwner.data?.rows, configured: asOwner.data?.configured }));
  }

  // ----------------------------------------------------------- importing ----
  step('Bringing an existing book across');

  const pasted = [
    'CLIENT\tBOOKING AGENT\tVENDOR\tDEPARTURE DATE\tCONFIRMATION',
    `Montoro, Manuel\tB Beasley\tMargaritaville at Sea (Margaritaville at Sea Beachcomber)\t3/11/27\tIMP1-${stamp}`,
    `Gallo, James\tB Beasley\tCelebrity Cruises - Ocean (Celebrity Ascent)\t9/17/27\tIMP2-${stamp}`,
    `\tB Beasley\tNobody Cruises\t1/1/27\tIMP3-${stamp}`,
    `Bearse, Charlotte\tB Beasley\tVirgin Voyages\tnot a date\tIMP4-${stamp}`,
  ].join('\n');

  const pv = await call(advisor, 'POST', '/api/import/preview', { text: pasted });
  check(pv.status === 200 && pv.data?.skippedHeader === true,
    'a heading row is recognised and not imported as data', pv.data?.skippedHeader);
  check(pv.data?.columns?.[1] === '',
    'a column that means nothing here is ignored rather than guessed at',
    JSON.stringify(pv.data?.columns));

  const first = pv.data.rows[0];
  check(first.clientName === 'Manuel Montoro',
    'surname first is turned around, since every screen afterwards reads it', first.clientName);
  check(first.supplier === 'Margaritaville at Sea' && first.productName === 'Beachcomber',
    'the vendor and the ship are separated, and the vendor is not repeated',
    `${first.supplier} / ${first.productName}`);
  check(first.departDate === '2027-03-11',
    'a two digit year is read as this century, not the last', first.departDate);

  check(pv.data.rows[2].problems.length === 1,
    'a row with no client is flagged rather than dropped in silence',
    JSON.stringify(pv.data.rows[2].problems));
  check(/could not read the date/.test(pv.data.rows[3].problems[0] || ''),
    'and so is a date nobody can parse', pv.data.rows[3].problems[0]);
  check(pv.data.summary.ready === 2 && pv.data.summary.problems === 2,
    'the preview counts what will actually happen', JSON.stringify(pv.data.summary));

  const ran = await call(advisor, 'POST', '/api/import/reservations', { text: pasted });
  check(ran.data?.created === 2 && ran.data?.skipped === 2,
    'the import creates the sound rows and skips the rest', JSON.stringify(ran.data));

  const imported = await call(advisor, 'GET', `/api/bookings?q=IMP1-${stamp}`);
  const madeIt = (imported.data?.bookings || [])[0];
  check(madeIt && madeIt.client_name === 'Manuel Montoro', 'and they are real reservations');
  for (const b of imported.data?.bookings || []) {
    cleanup('an imported reservation', () => call(advisor, 'DELETE', `/api/bookings/${b.id}`));
  }
  const alsoImported = await call(advisor, 'GET', `/api/bookings?q=IMP2-${stamp}`);
  for (const b of alsoImported.data?.bookings || []) {
    cleanup('an imported reservation', () => call(advisor, 'DELETE', `/api/bookings/${b.id}`));
  }

  // Pasting the same list twice is the single likeliest mistake, since the
  // source is paged and it is easy to lose your place.
  const twice = await call(advisor, 'POST', '/api/import/reservations', { text: pasted });
  check(twice.data?.created === 0 && twice.data?.skipped === 4,
    'running the same paste again imports nothing', JSON.stringify(twice.data));

  const clientMade = await call(advisor, 'GET', '/api/clients?q=Manuel%20Montoro');
  check((clientMade.data?.clients || []).some((c) => c.name === 'Manuel Montoro'),
    'and importing creates the client records too');

  // ------------------------------------------------------------- chasing ----
  // Braced, so the names inside belong to this section. Everything above
  // shares one function scope, and adding a section has twice collided with a
  // `const` three hundred lines away. New sections get a block.
  {
  step('Chasing a client about a payment');

  const chaseTrip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Chase Client ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(90), gross: '6000', deposit: '600',
    depositDue: isoDay(5), finalPaymentDue: isoDay(45),
  });
  const chaseId = chaseTrip.data?.booking?.id;
  if (chaseId) cleanup('the chase reservation', () => call(advisor, 'DELETE', `/api/bookings/${chaseId}`));
  await call(advisor, 'POST', `/api/bookings/${chaseId}/schedule`, {});
  const chaseRecord = await call(advisor, 'GET', `/api/bookings/${chaseId}/record`);
  const chasePayment = (chaseRecord.data?.payments || []).find((p) => p.kind === 'final' && p.payment_class === 'hard');
  check(chasePayment, 'there is a balance to chase');

  // Without an address the answer is the fix, not a failure: the email goes on
  // the client record, and saying so is more use than "send failed".
  const noEmail = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(noEmail.data?.problem && noEmail.data?.clientId,
    'a client with no email is named, with somewhere to go and fix it',
    noEmail.data?.problem);
  const refusedSend = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, {});
  check(refusedSend.status === 400, 'and sending is refused rather than half done',
    `status ${refusedSend.status}`);

  const clients2 = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(`Chase Client ${stamp}`)}`);
  const chaseClient = (clients2.data?.clients || [])[0];
  await call(advisor, 'PUT', `/api/clients/${chaseClient.id}`, {
    name: `Chase Client ${stamp}`, email: `chase-${stamp}@example.com`,
  });

  const ready = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(ready.data?.to === `chase-${stamp}@example.com` && !ready.data.problem,
    'once an address is on file the preview is ready', ready.data?.to);
  check(ready.data?.details?.hard === true && ready.data.details.amountCents === 540000,
    'and it carries the real balance and says it is a vendor deadline',
    JSON.stringify({ hard: ready.data?.details?.hard, amount: ready.data?.details?.amountCents }));
  check(ready.data?.details?.replyTo === ADVISOR_EMAIL,
    'replies come back to the advisor, not to the software', ready.data?.details?.replyTo);
  check(ready.data?.alreadySent === null, 'and nothing has been sent yet');

  // A send that fails must not record a reminder. An advisor who believes a
  // client was chased when they were not is worse off than one who knows they
  // were not, and this is the case that happens: email misconfigured.
  const attempted = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, {});
  const after = await call(advisor, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  if (attempted.status === 200) {
    check(after.data?.alreadySent, 'a sent reminder is remembered', after.data?.alreadySent);
    check(after.data?.sentCount === 1, 'and counted', after.data?.sentCount);
  } else {
    check(after.data?.alreadySent === null,
      'a send that failed records nothing, so nobody thinks a client was chased',
      `send said ${attempted.status}, alreadySent ${after.data?.alreadySent}`);
    console.log('        (email is not configured here, so the send itself cannot be exercised)');
  }

  // Chasing money that has arrived is the kind of message that loses a client.
  const paidOne = (chaseRecord.data?.payments || []).find((p) => p.kind === 'deposit');
  await call(advisor, 'POST', `/api/payments/${paidOne.id}/paid`, {});
  const chasePaid = await call(advisor, 'POST', `/api/payments/${paidOne.id}/remind`, { preview: true });
  check(chasePaid.status === 400, 'a payment already posted cannot be chased',
    `status ${chasePaid.status}`);

  const notYourPayment = await call(admin, 'POST', `/api/payments/${chasePayment.id}/remind`, { preview: true });
  check(notYourPayment.status === 404, 'and an owner cannot chase on an associate\'s behalf',
    `status ${notYourPayment.status}`);
  }

  // -------------------------------------------------- filling in the gaps ---
  step('Filling in what an import could not carry');

  const bare = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Bare Import ${stamp}`, supplier: 'Carnival', confirmationNumber: `BARE-${stamp}`,
    departDate: isoDay(150), status: 'booked',
  });
  const bareId = bare.data?.booking?.id;
  if (bareId) cleanup('the bare reservation', () => call(advisor, 'DELETE', `/api/bookings/${bareId}`));
  check(bare.data?.booking?.gross_cents === 0 && !bare.data?.booking?.final_payment_due,
    'an imported reservation starts with no cost and no deadline');

  // The whole point of a partial update: touch one field, leave the rest.
  const one = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`, { gross: '4250.00' });
  check(one.data?.booking?.gross_cents === 425000, 'one field can be set on its own',
    one.data?.booking?.gross_cents);
  check(one.data?.booking?.client_name === `Bare Import ${stamp}`
        && one.data.booking.supplier === 'Carnival'
        && one.data.booking.depart_date === isoDay(150),
    'and everything it was not told about is left alone',
    JSON.stringify({ n: one.data?.booking?.client_name, s: one.data?.booking?.supplier }));

  const dated = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { finalPaymentDue: isoDay(60) });
  check(dated.data?.booking?.final_payment_due === isoDay(60)
        && dated.data.booking.gross_cents === 425000,
    'a second field does not undo the first', dated.data?.booking?.final_payment_due);

  // The same rules the full dialog enforces, checked against what would be
  // stored rather than only what was sent.
  const tooMuch = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { commission: '99999.00' });
  check(tooMuch.status === 400,
    'commission above the trip cost is refused even when the cost was not sent',
    `status ${tooMuch.status}`);

  const backwards = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`,
    { returnDate: isoDay(140) });
  check(backwards.status === 400, 'and a return before the departure already on file',
    `status ${backwards.status}`);

  const empty = await call(advisor, 'POST', `/api/bookings/${bareId}/quick`, { nonsense: 1 });
  check(empty.status === 400, 'a request that names no known field changes nothing',
    `status ${empty.status}`);

  const notYours = await call(admin, 'POST', `/api/bookings/${bareId}/quick`, { gross: '1.00' });
  check(notYours.status === 404, 'and an owner cannot quick edit an associate\'s reservation',
    `status ${notYours.status}`);

  // ---------------------------------------------------- the client record ---
  step('One client on one screen');

  const who = `Repeat Client ${stamp}`;
  const past1 = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-400), returnDate: isoDay(-393), gross: '3000', commission: '300',
  });
  const past2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Oceania', status: 'travelled',
    departDate: isoDay(-200), returnDate: isoDay(-190), gross: '5000', commission: '500',
  });
  const dead = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Oceania', status: 'cancelled',
    departDate: isoDay(-100), gross: '9000', commission: '900',
  });
  const ahead = await call(advisor, 'POST', '/api/bookings', {
    clientName: who, supplier: 'Virgin Voyages', status: 'booked',
    departDate: isoDay(120), returnDate: isoDay(127), gross: '4000', commission: '400',
  });
  for (const r of [past1, past2, dead, ahead]) {
    if (r.data?.booking?.id) cleanup('a client reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const clientCredit = await call(advisor, 'POST', '/api/credits',
    { clientName: who, vendor: 'Carnival', amount: '150', expiresOn: isoDay(200) });
  if (clientCredit.data?.credit?.id) cleanup('the client credit', () =>
    call(advisor, 'DELETE', `/api/credits/${clientCredit.data.credit.id}`));

  // A client record appears as a side effect of taking a reservation, so
  // nobody has to keep a list of people before they can do the work.
  const clientList = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(who)}`);
  const madeClient = (clientList.data?.clients || []).find((c) => c.name === who);
  check(madeClient, 'booking someone creates their client record', madeClient && madeClient.id);
  check(madeClient && madeClient.trips === 3 && madeClient.lifetime_cents === 1200000,
    'with trips and lifetime value counted on the list too',
    madeClient && `${madeClient.trips} trips, ${madeClient.lifetime_cents}`);

  // Contact details are what turn "worth a call" into a call.
  const detailed = await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, {
    name: who, phone: '+1 555 0142', email: 'repeat@example.com', notes: 'Prefers a balcony.',
  });
  check(detailed.data?.client?.phone === '+1 555 0142', 'a phone number can be recorded',
    detailed.data?.client?.phone);

  const pinnedClient = await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, { pinned: true });
  check(pinnedClient.status === 200, 'and a client can be pinned');
  const onlyPinned = await call(advisor, 'GET', '/api/clients?pinned=1');
  check((onlyPinned.data?.clients || []).some((c) => c.id === madeClient.id),
    'which filters the list');

  const notTheirClient = await call(admin, 'PUT', `/api/clients/${madeClient.id}`, { pinned: false });
  check(notTheirClient.status === 404, 'an owner cannot pin an associate\'s client',
    `status ${notTheirClient.status}`);

  const rec2 = await call(advisor, 'GET', `/api/client?id=${madeClient.id}`);
  const cl = rec2.data?.client;
  check(rec2.status === 200 && cl?.name === who, 'the client record loads', `status ${rec2.status}`);

  // A cancelled trip is not lifetime value. Counting it would flatter every
  // client who ever changed their mind.
  check(cl.lifetimeCents === 1200000 && cl.trips === 3,
    'lifetime value counts booked and travelled, not cancelled',
    `${cl.lifetimeCents} over ${cl.trips} trips`);
  check(cl.commissionCents === 120000, 'and commission with it', cl.commissionCents);
  check(cl.nextDeparture === isoDay(120),
    'the next departure is the soonest one still ahead', cl.nextDeparture);
  check(cl.lastTravelled === isoDay(-190),
    'and last travelled is the most recent one behind', cl.lastTravelled);
  check(cl.creditCents === 15000, 'unused credit is carried on the record', cl.creditCents);
  check(cl.vendors.length === 3, 'along with every vendor they have used', cl.vendors.join(', '));

  const renamed = `Renamed Client ${stamp}`;
  await call(advisor, 'PUT', `/api/clients/${madeClient.id}`, { name: renamed });
  const afterRename = await call(advisor, 'GET', `/api/client?id=${madeClient.id}`);
  check(afterRename.data?.client?.name === renamed && afterRename.data.bookings.length === 4,
    'renaming a client carries their reservations along',
    `${afterRename.data?.client?.name}, ${afterRename.data?.bookings?.length} trips`);
  check((afterRename.data?.bookings || []).every((b) => b.client_name === renamed),
    'and the name on each reservation follows');

  const noSuch = await call(advisor, 'GET', '/api/client?name=Nobody%20At%20All');
  check(noSuch.status === 404, 'a client with no trips is a 404', `status ${noSuch.status}`);

  // Same boundary as everywhere else: an associate must not read the owner's
  // client through a name they can guess.
  const ownerClient = await call(admin, 'POST', '/api/bookings', {
    clientName: `Owner Only ${stamp}`, supplier: 'Cunard', status: 'travelled',
    departDate: isoDay(-30), returnDate: isoDay(-20), gross: '7000', commission: '700',
  });
  if (ownerClient.data?.booking?.id) cleanup('the owner client reservation', () =>
    call(admin, 'DELETE', `/api/bookings/${ownerClient.data.booking.id}`));
  const peek = await call(advisor, 'GET', `/api/client?name=${encodeURIComponent(`Owner Only ${stamp}`)}`);
  check(peek.status === 404, 'and an associate cannot read the owner\'s client by name',
    `status ${peek.status}`);

  // -------------------------------------------------------- commission ------
  step('Commission the agency is owed');

  // Three trips: one home a fortnight, one home four months, one not yet gone.
  // The point of the report is that they are not the same problem.
  const recent = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Recent ${stamp}`, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-21), returnDate: isoDay(-14), gross: '4000', commission: '400',
  });
  const stale = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Stale ${stamp}`, supplier: 'Carnival', status: 'travelled',
    departDate: isoDay(-130), returnDate: isoDay(-120), gross: '6000', commission: '600',
  });
  const future = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Comm Future ${stamp}`, supplier: 'Oceania', status: 'booked',
    departDate: isoDay(60), returnDate: isoDay(70), gross: '9000', commission: '900',
  });
  for (const r of [recent, stale, future]) {
    if (r.data?.booking?.id) cleanup('a commission reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const comm = await call(advisor, 'GET', '/api/commissions');
  const find = (id) => (comm.data?.rows || []).find((r) => r.id === id);
  check(find(recent.data.booking.id)?.bucket === 'd30',
    'a trip home a fortnight ago is inside normal turnaround',
    find(recent.data.booking.id)?.bucket);
  check(find(stale.data.booking.id)?.bucket === 'older',
    'one home four months ago is over ninety days',
    find(stale.data.booking.id)?.bucket);
  check(find(future.data.booking.id)?.bucket === 'travelling',
    'and one that has not departed is not late at all',
    find(future.data.booking.id)?.bucket);

  // The distinction the whole report rests on: everything eventually due
  // versus what can actually be claimed today.
  check(comm.data.totals.owedCents - comm.data.totals.claimableCents >= 90000,
    'claimable excludes trips that have not happened yet',
    `${comm.data.totals.owedCents} owed, ${comm.data.totals.claimableCents} claimable`);

  const carnival = (comm.data?.byVendor || []).find((v) => v.vendor === 'Carnival');
  check(carnival && carnival.cents >= 100000, 'and it totals by vendor',
    carnival && carnival.cents);

  // Chasing happens one vendor statement at a time, so the update is a batch.
  const marked = await call(advisor, 'POST', '/api/commissions/status', {
    ids: [recent.data.booking.id, stale.data.booking.id], status: 'invoiced',
  });
  check(marked.data?.changed === 2, 'several move to invoiced at once', marked.data?.changed);

  // An owner may read an associate's commission but not declare it paid, and
  // the response says how many actually moved rather than how many were asked
  // for, so a silent no-op is impossible.
  const notTheirs = await call(admin, 'POST', '/api/commissions/status', {
    ids: [recent.data.booking.id], status: 'paid',
  });
  check(notTheirs.data?.changed === 0 && notTheirs.data?.requested === 1,
    'an owner cannot mark an associate\'s commission paid',
    JSON.stringify(notTheirs.data));

  const paidOff = await call(advisor, 'POST', '/api/commissions/status', {
    ids: [stale.data.booking.id], status: 'paid',
  });
  check(paidOff.data?.changed === 1, 'and marking one paid works');
  const after = await call(advisor, 'GET', '/api/commissions');
  check(!(after.data?.rows || []).some((r) => r.id === stale.data.booking.id
    && r.commission_status !== 'paid'), 'after which it stops being owed');
  check(after.data.totals.lateCents < comm.data.totals.lateCents,
    'and the over ninety days figure falls',
    `${after.data.totals.lateCents} from ${comm.data.totals.lateCents}`);

  const badStatus = await call(advisor, 'POST', '/api/commissions/status',
    { ids: [recent.data.booking.id], status: 'nonsense' });
  check(badStatus.status === 400, 'an unknown status is refused rather than defaulted',
    `status ${badStatus.status}`);

  // ------------------------------------------------ the reservation record --
  step('One trip on one screen');

  const rec = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(rec.status === 200 && rec.data?.booking?.id === bookingId,
    'the record loads', `status ${rec.status}`);
  check(Array.isArray(rec.data?.payments) && rec.data.payments.length >= 2,
    'with the schedule on it', `${rec.data?.payments?.length} payment(s)`);
  check(rec.data?.editable === true, 'and the owner of it may change it');

  // The quiet number: what is neither posted nor even scheduled. A trip worth
  // five thousand with a five hundred deposit and nothing else planned has
  // four and a half thousand that nothing will ever chase.
  const m = rec.data?.money || {};
  check(m.paidCents + m.scheduledCents + m.unscheduledCents === rec.data.booking.gross_cents,
    'and the three money figures account for the whole trip',
    `${m.paidCents} + ${m.scheduledCents} + ${m.unscheduledCents} vs ${rec.data.booking.gross_cents}`);

  const recTask = await call(advisor, 'POST', '/api/tasks',
    { title: `From the record ${stamp}`, bookingId });
  if (recTask.data?.task?.id) cleanup('the record task', () =>
    call(advisor, 'DELETE', `/api/tasks/${recTask.data.task.id}`));
  const withTask = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check((withTask.data?.tasks || []).some((t) => t.id === recTask.data?.task?.id),
    'a task added against the trip shows on its record');

  // An owner may read an associate's trip, and its schedule with it, but the
  // record says plainly that they cannot change it.
  const ownerRec = await call(admin, 'GET', `/api/bookings/${bookingId}/record`);
  check(ownerRec.status === 200 && ownerRec.data?.editable === false,
    'an owner sees the record read only', `status ${ownerRec.status}, editable ${ownerRec.data?.editable}`);
  check((ownerRec.data?.payments || []).length === (rec.data?.payments || []).length,
    'with the same schedule, not an empty one',
    `${ownerRec.data?.payments?.length} vs ${rec.data?.payments?.length}`);

  const strangerRec = await call(admin, 'GET', '/api/bookings/does-not-exist/record');
  check(strangerRec.status === 404, 'and a reservation that is not there is a 404',
    `status ${strangerRec.status}`);

  // ------------------------------------------------------------ targets -----
  step('Targets, and whether you are on course');

  const year = Number(isoDay(0).slice(0, 4));
  const blank = await call(advisor, 'GET', `/api/goals?year=${year}`);
  check(blank.status === 200 && blank.data?.goals?.set === false,
    'a new advisor has no target set', JSON.stringify(blank.data?.goals?.set));

  const set = await call(advisor, 'PUT', '/api/goals', {
    year, basis: 'purchase', salesGoal: '100000', commissionGoal: '10000', bookingsGoal: 50,
    aim: 'Fewer, better clients.', edge: 'I have sailed the ships I sell.',
  });
  const g = set.data?.goals;
  check(set.status === 200 && g?.sales?.goal === 10000000,
    'a target is stored in cents', g?.sales?.goal);
  cleanup('the target', () => call(advisor, 'PUT', '/api/goals', {
    year, basis: 'purchase', salesGoal: '0', commissionGoal: '0', bookingsGoal: 0, aim: '', edge: '',
  }));

  // Pace is the reason the target is worth showing at all: how much should be
  // done by today. Checked against the elapsed fraction rather than a fixed
  // number, since the answer changes every day this test runs.
  // elapsed is rounded to a tenth of a percent for display, so recomputing
  // from it cannot land on the exact figure. The tolerance is that rounding,
  // not a fudge: half of 0.1% of the goal.
  const expectedPace = Math.round(g.sales.goal * (g.elapsed / 100));
  const tolerance = g.sales.goal * 0.0005 + 1;
  check(Math.abs(g.sales.pace - expectedPace) <= tolerance,
    'pace follows from how much of the year has gone',
    `${g.sales.pace} vs ${expectedPace} at ${g.elapsed}%`);
  check(g.sales.ahead === g.sales.actual - g.sales.pace,
    'and ahead or behind is measured against the pace, not the target',
    `${g.sales.ahead}`);

  const goalReread = await call(advisor, 'GET', `/api/goals?year=${year}`);
  check(goalReread.data?.goals?.aim === 'Fewer, better clients.', 'the wording is kept too',
    goalReread.data?.goals?.aim);

  // The basis is part of the target, not a display option: the same number
  // means different things counted each way.
  const byDeparture = await call(advisor, 'PUT', '/api/goals', {
    year, basis: 'departure', salesGoal: '100000', commissionGoal: '10000', bookingsGoal: 50,
  });
  check(byDeparture.data?.goals?.basis === 'departure', 'the basis is stored with it',
    byDeparture.data?.goals?.basis);
  check(byDeparture.data?.goals?.sales?.actual !== g.sales.actual
        || byDeparture.data.goals.sales.actual === 0,
    'and changing it changes what counts towards the target',
    `${g.sales.actual} by purchase vs ${byDeparture.data?.goals?.sales?.actual} by departure`);

  // A target is personal even for an owner, so the agency scope must not leak
  // into it and ?advisor= must not redirect it at somebody else.
  // Asserted as "not the associate's" rather than "unset": the owner may well
  // have targets of their own, and a test that only passes on a fresh account
  // is a test that gets deleted the first time it is inconvenient.
  const ownerGoals = await call(admin, 'GET', `/api/goals?year=${year}&advisor=${created.id}`);
  check(ownerGoals.data?.goals?.aim !== 'Fewer, better clients.',
    'an owner asking for their targets gets their own, not an advisor\'s',
    ownerGoals.data?.goals?.aim);

  const junkYear = await call(advisor, 'GET', '/api/goals?year=1066');
  check(junkYear.data?.goals?.year === year, 'and an impossible year falls back to this one',
    junkYear.data?.goals?.year);

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
