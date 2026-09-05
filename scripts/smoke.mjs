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
// Sections that could not run here rather than sections that passed. Counted
// apart from the checks and named at the end, because a suite that quietly
// shrinks by eight on a machine with no catalog is a suite reporting a number
// that means something different from run to run.
const skips = [];

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
function skip(what, why) {
  skips.push(what);
  console.log(`  skip  ${what}`);
  console.log(`        ${why}`);
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

  // ------------------------------------------------------------- pricing ----
  {
  step('What the client pays, and what earns commission');

  const priced = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Priced ${stamp}`, supplier: `Petrel Line ${stamp}`,
    departDate: isoDay(250), status: 'booked',
  });
  const pricedId = priced.data?.booking?.id;
  if (pricedId) cleanup('the priced reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${pricedId}`));

  const vl = await call(advisor, 'GET', '/api/vendors');
  const kestrel = (vl.data?.vendors || []).find((v) => v.name === `Petrel Line ${stamp}`);
  await call(advisor, 'PUT', `/api/vendors/${kestrel.id}`,
    { name: kestrel.name, commissionPct: 16 });

  // A real cruise price: fare earns, non-commissionable fare and taxes do not.
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'fare', label: 'Cruise fare', amount: '1400.00', commissionable: true, commission: '224.00' });
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'ncf', label: 'NCF', amount: '298.00' });
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'taxes', label: 'Port taxes', amount: '298.00' });

  const rec = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  const sum = rec.data?.priceSummary;
  check(sum.clientTotalCents === 199600, 'the client total is every line added up', sum.clientTotalCents);
  check(sum.commissionableCents === 140000,
    'and the commissionable part excludes taxes and NCF', sum.commissionableCents);

  // The whole reason for the split. The rate against everything the client
  // paid looks like an underpayment; the rate against what the vendor pays on
  // is exactly their stated rate.
  check(sum.effectivePct === 11.2 && sum.truePct === 16,
    'so the two rates differ, and only one of them means anything',
    `${sum.effectivePct}% of everything, ${sum.truePct}% of the commissionable part`);
  check(sum.expectedCents === 22400 && sum.varianceCents === 0,
    'and the vendor paid exactly their own rate', JSON.stringify({ e: sum.expectedCents, v: sum.varianceCents }));

  // The headline figures follow the breakdown, so two sets of numbers cannot
  // drift apart.
  check(rec.data?.booking?.gross_cents === 199600 && rec.data.booking.commission_cents === 22400,
    'the reservation totals follow the breakdown');

  // A short payment is the thing an agency never notices.
  const lines = rec.data.pricing;
  const fare = lines.find((l) => l.kind === 'fare');
  await call(advisor, 'PUT', `/api/pricing/${fare.id}`,
    { kind: 'fare', label: 'Cruise fare', amount: '1400.00', commissionable: true, commission: '180.00' });
  const short = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  check(short.data?.priceSummary?.varianceCents === -4400,
    'and a vendor paying under their rate shows as a shortfall',
    short.data?.priceSummary?.varianceCents);

  // A discount reduces what the client pays without ever earning commission,
  // and goes in as a positive number so nobody has to type a minus sign.
  await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'discount', label: 'Onboard credit applied', amount: '100.00', commissionable: true });
  const discounted = await call(advisor, 'GET', `/api/bookings/${pricedId}/record`);
  check(discounted.data?.priceSummary?.clientTotalCents === 189600,
    'a discount is subtracted from what the client pays',
    discounted.data?.priceSummary?.clientTotalCents);
  check(discounted.data?.priceSummary?.commissionableCents === 140000,
    'and never counts as commissionable, whatever the box said',
    discounted.data?.priceSummary?.commissionableCents);

  const silly = await call(advisor, 'POST', `/api/bookings/${pricedId}/pricing`,
    { kind: 'fare', amount: '100.00', commission: '500.00' });
  check(silly.status === 400, 'commission larger than its own line is refused',
    `status ${silly.status}`);

  // No breakdown means no summary. An empty one reads as zero, and zero is a
  // claim rather than an absence.
  const bare2 = await call(advisor, 'GET', `/api/bookings/${bookingId}/record`);
  check(bare2.data?.priceSummary === null, 'a reservation with no breakdown reports none');
  }

  // ---------------------------------------------- the people on the trip ----
  {
  step('Travellers, passports and amenities');

  const trip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Party Lead ${stamp}`, supplier: 'Cunard', status: 'booked',
    departDate: isoDay(300), returnDate: isoDay(314), gross: '9000', commission: '900',
    cabin: '1223', cabinCategory: 'Picturesque Oceanview', itinerary: '14 Night Transatlantic',
    insuranceStatus: 'declined', bookingMethod: 'portal',
  });
  const tripId = trip.data?.booking?.id;
  if (tripId) cleanup('the party reservation', () => call(advisor, 'DELETE', `/api/bookings/${tripId}`));
  check(trip.data?.booking?.cabin === '1223' && trip.data.booking.cabin_category === 'Picturesque Oceanview',
    'a reservation carries a cabin and its category', trip.data?.booking?.cabin);

  // Insurance is not a boolean. Declined is a different fact from not asked,
  // and it is the difference that matters if something goes wrong later.
  check(trip.data?.booking?.insurance_status === 'declined',
    'and records that the client declined insurance, rather than nothing',
    trip.data?.booking?.insurance_status);
  const silent = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Silent ${stamp}`, departDate: isoDay(300), status: 'quoted',
  });
  if (silent.data?.booking?.id) cleanup('the quiet reservation', () =>
    call(advisor, 'DELETE', `/api/bookings/${silent.data.booking.id}`));
  check(silent.data?.booking?.insurance_status === 'unknown',
    'while saying nothing leaves it unknown, not declined',
    silent.data?.booking?.insurance_status);

  const lead = await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Ada Lovelace', dob: '1965-12-10', email: 'ada@example.com',
    passportNumber: 'P1', passportExpiry: isoDay(3000), isLead: true,
  });
  check(lead.status === 201, 'a traveller can be named');

  // Six months past the return date, not six months from today: the rule is
  // applied on arrival, so a passport valid now can still be refused later.
  await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Soon Expiring', passportNumber: 'P2', passportExpiry: isoDay(400),
  });
  await call(advisor, 'POST', `/api/bookings/${tripId}/travellers`, {
    name: 'Already Expired', passportNumber: 'P3', passportExpiry: isoDay(310),
  });

  const rec3 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const byName = Object.fromEntries((rec3.data?.travellers || []).map((t) => [t.name, t]));
  check(byName['Already Expired']?.passportWarning === 'expires before they get home',
    'a passport that runs out mid trip is flagged',
    byName['Already Expired']?.passportWarning);
  check(/six months/.test(byName['Soon Expiring']?.passportWarning || ''),
    'and so is one inside the six month rule',
    byName['Soon Expiring']?.passportWarning);
  check(byName['Ada Lovelace']?.passportWarning === null,
    'while a valid one says nothing at all');
  check(byName['Ada Lovelace']?.is_lead === 1, 'the lead traveller is marked');

  // The count follows the people, so the two can never disagree.
  check(rec3.data?.booking?.travellers === 3,
    'and the traveller count follows the names on the record',
    rec3.data?.booking?.travellers);

  // Only one lead: a vendor confirmation names one person.
  await call(advisor, 'PUT', `/api/travellers/${byName['Soon Expiring'].id}`,
    { name: 'Soon Expiring', isLead: true });
  const rec4 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((rec4.data?.travellers || []).filter((t) => t.is_lead).length === 1,
    'and naming a second lead moves it rather than adding one');

  const amenity = await call(advisor, 'POST', `/api/bookings/${tripId}/amenities`, {
    description: 'Onboard credit', amount: '250', source: 'vendor', status: 'requested',
  });
  check(amenity.status === 201, 'an amenity can be recorded');
  const rec5 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  const am = (rec5.data?.amenities || [])[0];
  check(am && am.amount_cents === 25000 && am.status === 'requested',
    'with its value and where it stands', am && `${am.amount_cents} ${am.status}`);

  await call(advisor, 'PUT', `/api/amenities/${am.id}`, { status: 'applied' });
  const rec6 = await call(advisor, 'GET', `/api/bookings/${tripId}/record`);
  check((rec6.data?.amenities || [])[0]?.status === 'applied',
    'and it can be moved along without resending the whole thing');

  const notYours2 = await call(admin, 'POST', `/api/bookings/${tripId}/travellers`, { name: 'Intruder' });
  check(notYours2.status === 404, 'an owner cannot add a traveller to an associate\'s reservation',
    `status ${notYours2.status}`);
  }

  // ------------------------------------------------------------- vendors ----
  {
  step('Vendors, their spelling and their terms');

  // Two spellings of one vendor, exactly as a pasted book produces.
  const v1 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Vendor A ${stamp}`, supplier: `Kestrel Cruises ${stamp}`,
    departDate: isoDay(200), gross: '3000', commission: '300', status: 'booked',
  });
  const v2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Vendor B ${stamp}`, supplier: `Kestrel Cruises ${stamp} - Ocean`,
    departDate: isoDay(220), gross: '4000', commission: '400', status: 'booked',
  });
  for (const r of [v1, v2]) {
    if (r.data?.booking?.id) cleanup('a vendor reservation', () =>
      call(advisor, 'DELETE', `/api/bookings/${r.data.booking.id}`));
  }

  const vlist = await call(advisor, 'GET', '/api/vendors');
  const mine2 = (vlist.data?.vendors || []).filter((v) => v.name.includes(`Kestrel Cruises ${stamp}`));
  check(mine2.length === 2, 'booking a vendor creates its record', `${mine2.length} vendor(s)`);
  check(mine2.some((v) => v.trips === 1), 'with its reservations counted');

  const group = (vlist.data?.stats?.possibleDuplicates || [])
    .find((g) => g.some((v) => v.name.includes(`Kestrel Cruises ${stamp}`)));
  check(group && group.length === 2,
    'and two spellings of one name are offered as a possible duplicate',
    group && group.map((v) => v.name).join(' / '));

  // Every duplicate offered has to be mergeable, which means every vendor in
  // the group has to belong to the caller. Grouping across advisors offers a
  // merge that would quietly move nothing.
  const everyGroupIsMine = (vlist.data?.stats?.possibleDuplicates || []).every((g) =>
    g.every((v) => (vlist.data.vendors.find((x) => x.id === v.id) || {}).user_id
      === (vlist.data.vendors.find((x) => x.id === g[0].id) || {}).user_id));
  check(everyGroupIsMine, 'and a group never spans two advisors');

  const keep = group.find((v) => v.trips === 1) || group[0];
  const merged = await call(advisor, 'POST', '/api/vendors/merge', {
    keep: keep.id, drop: group.filter((v) => v.id !== keep.id).map((v) => v.id),
  });
  check(merged.data?.reservationsMoved >= 1, 'merging moves the reservations',
    JSON.stringify(merged.data));

  // Searched on the full stamped name rather than "Kestrel": another section
  // creates its own vendor, and a query loose enough to catch it turns a
  // passing assertion into a puzzle.
  const afterMerge = await call(advisor, 'GET',
    `/api/bookings?q=${encodeURIComponent(`Kestrel Cruises ${stamp}`)}`);
  const suppliers = new Set((afterMerge.data?.bookings || []).map((b) => b.supplier));
  check(suppliers.size === 1,
    'and rewrites the name on them, so a report stops splitting', [...suppliers].join(' / '));

  // Terms turn a departure into a deadline, which is the only reason an
  // imported reservation is any use.
  await call(advisor, 'PUT', `/api/vendors/${keep.id}`, { name: keep.name, finalDays: 90 });
  const dates = await call(advisor, 'GET', '/api/vendors/suggest-dates');
  const forMine = (dates.data?.suggestions || []).filter((sg) => sg.vendor === keep.name);
  check(forMine.length >= 1, 'a vendor with terms suggests a final payment date',
    `${forMine.length} suggestion(s)`);
  const one = forMine[0];
  const expected = new Date(Date.parse(`${one.departDate}T00:00:00Z`) - 90 * 86400000)
    .toISOString().slice(0, 10);
  check(one.suggested === expected, 'worked back from departure by the vendor\'s own terms',
    `${one.suggested} vs ${expected}`);

  // Suggested, never applied. A vendor's standard terms are a good guess, and
  // a date written in by software cannot be told apart afterwards from one an
  // advisor confirmed.
  const stillEmpty = await call(advisor, 'GET', `/api/bookings/${one.id}`);
  check(!stillEmpty.data?.booking?.final_payment_due,
    'and nothing is written until it is applied');

  const notYourVendor = await call(admin, 'PUT', `/api/vendors/${keep.id}`,
    { name: 'Hijacked', finalDays: 1 });
  check(notYourVendor.status === 404, 'an owner cannot rewrite an associate\'s vendor',
    `status ${notYourVendor.status}`);
  }

  // ------------------------------------------------------------- catalog ----
  {
  step('The sailing catalog');

  const lines = await call(advisor, 'GET', '/api/catalog/lines');
  check(lines.status === 200, 'the catalog answers', `status ${lines.status}`);

  if (!lines.data?.ready) {
    skip('the sailing catalog',
      'nothing imported here; set CRUISEFEED_KEY and let the cron run to exercise it');
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

  // ------------------------------------------------ posting a payment ------
  {
  step('Posting a payment: who paid it, and with what');

  const settle = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Settle ${stamp}`, supplier: 'Holland America', status: 'booked',
    departDate: isoDay(240), returnDate: isoDay(252), gross: '1250', commission: '150',
  });
  const settleId = settle.data?.booking?.id;
  if (settleId) cleanup('the settled reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${settleId}`));

  const payer = await call(advisor, 'POST', `/api/bookings/${settleId}/travellers`,
    { name: `Ada Settle ${stamp}`, isLead: true });
  const payerId = payer.data?.id;

  const held = await call(advisor, 'POST', '/api/credits', {
    clientName: `Settle ${stamp}`, vendor: 'Holland America', kind: 'certificate',
    amount: '250', issuedOn: isoDay(-30), expiresOn: isoDay(300),
  });
  const heldId = held.data?.credit?.id;
  if (heldId) cleanup('the held credit', () => call(advisor, 'DELETE', `/api/credits/${heldId}`));

  // Silence is not a claim. Nobody said how this was paid, so nothing is
  // recorded about how it was paid.
  const quiet = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'deposit', amount: '1000', dueDate: isoDay(10),
  });
  check(quiet.status === 201 && quiet.data?.payment?.payment_type === null,
    'a payment nobody described has no payment type', quiet.data?.payment?.payment_type);

  const posted = await call(advisor, 'POST', `/api/payments/${quiet.data.payment.id}/paid`, {
    paidDate: isoDay(0), paymentType: 'card', paidBy: payerId, cardLast4: '4111 1111 4242',
  });
  check(posted.data?.payment?.payment_type === 'card' && posted.data?.payment?.paid_by === payerId,
    'posting one records how it was paid and by whom',
    `${posted.data?.payment?.payment_type} / ${posted.data?.payment?.paid_by}`);

  // Four digits, never the card. The rest is stripped rather than refused,
  // because an advisor pasting a whole number should not lose the payment.
  check(posted.data?.payment?.card_last4 === '4242',
    'and keeps the last four digits of a card and nothing more',
    posted.data?.payment?.card_last4);

  // A payer has to be on the trip they paid for.
  const stranger = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '10', dueDate: isoDay(20),
    paidBy: 'not-a-traveller',
  });
  check(stranger.status === 400, 'a payer who is not on the reservation is refused',
    `status ${stranger.status}`);

  // Spending a credit is a ledger move: it stops being the client's money.
  const spend = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '250', dueDate: isoDay(20),
    creditId: heldId,
  });
  const spendId = spend.data?.payment?.id;
  const stillOpen = await call(advisor, 'GET', '/api/credits?state=open');
  check((stillOpen.data?.credits || []).some((c) => c.id === heldId),
    'a credit a future payment intends to use is not spent yet');

  await call(advisor, 'POST', `/api/payments/${spendId}/paid`,
    { paidDate: isoDay(0), paymentType: 'future_cruise_credit' });
  const nowUsed = await call(advisor, 'GET', '/api/credits?state=used');
  const usedRow = (nowUsed.data?.credits || []).find((c) => c.id === heldId);
  check(Boolean(usedRow), 'posting the payment marks the credit used');
  check(usedRow?.booking_id === settleId, 'against the trip it was spent on', usedRow?.booking_id);

  // The same money cannot be spent twice.
  const twice = await call(advisor, 'POST', '/api/payments', {
    bookingId: settleId, kind: 'installment', amount: '250', paidDate: isoDay(0),
    creditId: heldId,
  });
  check(twice.status === 400, 'and the same credit cannot be applied to a second payment',
    `status ${twice.status}`);

  // The Payments page edits dates and amounts and knows nothing about payers.
  // An update from there must not quietly strip what it never carried.
  await call(advisor, 'PUT', `/api/payments/${quiet.data.payment.id}`, {
    bookingId: settleId, kind: 'deposit', amount: '1000',
    dueDate: isoDay(10), paidDate: isoDay(0),
  });
  const kept = await call(advisor, 'GET', `/api/bookings/${settleId}/record`);
  const keptRow = (kept.data?.payments || []).find((x) => x.id === quiet.data.payment.id);
  check(keptRow?.paid_by === payerId && keptRow?.card_last4 === '4242'
    && keptRow?.payment_type === 'card',
    'a partial edit leaves who paid, how, and the card alone',
    `${keptRow?.paid_by} / ${keptRow?.payment_type} / ${keptRow?.card_last4}`);

  check(keptRow?.paid_by_name === `Ada Settle ${stamp}`,
    'the record names the payer rather than showing an id', keptRow?.paid_by_name);
  const creditRow = (kept.data?.payments || []).find((x) => x.id === spendId);
  check(creditRow?.credit_amount_cents === 25000,
    'and shows the credit amount beside the payment it settled',
    creditRow?.credit_amount_cents);
  check((kept.data?.spendableCredits || []).some((c) => c.id === heldId),
    'the reservation offers this client\'s credits');

  // Deleting the payment hands the credit back. A credit left marked used
  // after its payment has gone is money the client owns and cannot see.
  await call(advisor, 'DELETE', `/api/payments/${spendId}`);
  const returned = await call(advisor, 'GET', '/api/credits?state=open');
  check((returned.data?.credits || []).some((c) => c.id === heldId),
    'deleting the payment gives the credit back to the client');
  }

  // ------------------------------------------------- client statement ------
  {
  step('What the client is told, and what they are not');

  const st = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Statement ${stamp}`, supplier: 'Princess Cruises', status: 'booked',
    productName: 'Alaska Inside Passage', confirmationNumber: `STMT-${stamp}`,
    departDate: isoDay(200), returnDate: isoDay(207), commission: '137.91',
    cabin: 'BA 620', cabinCategory: 'Balcony', itinerary: '7 Night Inside Passage',
  });
  const stId = st.data?.booking?.id;
  if (stId) cleanup('the statement reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${stId}`));

  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`,
    { kind: 'fare', amount: '2000', commissionable: true, commission: '137.91' });
  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`, { kind: 'taxes', amount: '318.55' });
  await call(advisor, 'POST', `/api/bookings/${stId}/pricing`,
    { kind: 'discount', label: 'Loyalty discount', amount: '100' });

  await call(advisor, 'POST', `/api/bookings/${stId}/travellers`,
    { name: 'Ruth Marlowe', passportNumber: 'X9Z7Q4471', passportExpiry: isoDay(2000), isLead: true });

  await call(advisor, 'POST', `/api/bookings/${stId}/amenities`,
    { description: 'Onboard credit', amount: '100', source: 'vendor', status: 'confirmed' });
  await call(advisor, 'POST', `/api/bookings/${stId}/amenities`,
    { description: 'Spa pass, still asking', source: 'vendor', status: 'requested' });

  const dep = await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'deposit', paymentClass: 'hard', amount: '500',
    dueDate: isoDay(-30), paidDate: isoDay(-30),
  });
  await call(advisor, 'POST', `/api/payments/${dep.data.payment.id}/paid`,
    { paidDate: isoDay(-30), paymentType: 'card', cardLast4: '9137' });
  await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'final', paymentClass: 'hard', amount: '1718.55', dueDate: isoDay(120),
  });
  // The advisor's own reminder, a week early, for the same money.
  await call(advisor, 'POST', '/api/payments', {
    bookingId: stId, kind: 'final', paymentClass: 'soft', amount: '1718.55', dueDate: isoDay(113),
  });

  const noAddress = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(noAddress.data?.problem && noAddress.data?.clientId,
    'a client with no email is named, with somewhere to go and fix it',
    noAddress.data?.problem);
  const refused = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, {});
  check(refused.status === 400, 'and sending is refused rather than half done',
    `status ${refused.status}`);

  const cl = await call(advisor, 'GET', `/api/clients?q=${encodeURIComponent(`Statement ${stamp}`)}`);
  await call(advisor, 'PUT', `/api/clients/${cl.data.clients[0].id}`,
    { name: `Statement ${stamp}`, email: `ruth-${stamp}@example.com` });

  const prev = await call(advisor, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  const sm = prev.data?.statement || {};
  check(prev.status === 200 && prev.data?.to === `ruth-${stamp}@example.com`,
    'once an address is on file the preview is ready', prev.data?.to);

  // 2000 + 318.55 - 100. A discount is stored positive and subtracted, the
  // same way it is on the advisor's screen, so the two cannot drift apart.
  check(sm.tripCents === 221855, 'the total is the breakdown, discount subtracted', sm.tripCents);
  check(sm.paidCents === 50000 && sm.balanceCents === 171855,
    'and the balance is the trip less what has arrived',
    `${sm.paidCents} paid, ${sm.balanceCents} left`);

  // The soft row is the advisor's private reminder for money already listed.
  // A client seeing both reads it as owing the balance twice.
  check(sm.due?.length === 1 && sm.due[0].amountCents === 171855,
    'only the vendor\'s own date is shown, not the advisor\'s reminder',
    JSON.stringify(sm.due));

  check(sm.amenities?.length === 1 && sm.amenities[0].description === 'Onboard credit',
    'what the vendor confirmed is included, what is still being asked for is not',
    JSON.stringify(sm.amenities));
  check(Array.isArray(sm.travellers) && sm.travellers[0] === 'Ruth Marlowe'
    && typeof sm.travellers[0] === 'string',
    'travellers are names, not records', JSON.stringify(sm.travellers));

  // The boundary this module exists for. Everything below is a fact the
  // reservation holds and the client must never receive.
  const asText = JSON.stringify(prev.data);
  check(!asText.includes('137.91') && !/commission/i.test(asText),
    'no commission figure reaches the client, in the data or the words');
  check(!asText.includes('X9Z7Q4471'), 'nor a passport number');
  check(!asText.includes('9137'), 'nor the digits of a card');
  check(!asText.includes(isoDay(113)), 'nor the advisor\'s private reminder date');

  const html = prev.data?.html || '';
  check(html.includes('Ruth Marlowe') && html.includes('2,218.55') && html.includes('1,718.55'),
    'while the trip, the people and the money are all there');
  check(html.includes('Loyalty discount') && !html.includes('Non-commissionable'),
    'in the client\'s words rather than the agency\'s');

  // The client has no account in the portal. Signing an email to them with a
  // link to its login page is the software talking over the advisor.
  check(!/advisor portal/i.test(html) && html.includes(ADVISOR_EMAIL),
    'and it is signed by the advisor, not by the portal');

  // A quote is not a statement. A client who has not booked has paid nothing
  // and owes nothing, and showing them "Received: $0.00" and a balance reads
  // as a demand for a trip they never agreed to.
  const quoted = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Statement ${stamp}`, supplier: 'Princess Cruises', status: 'quoted',
    productName: 'Mexican Riviera', departDate: isoDay(220), returnDate: isoDay(227),
    gross: '3200', deposit: '500', depositDue: isoDay(20),
  });
  const quotedId = quoted.data?.booking?.id;
  if (quotedId) cleanup('the quoted reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${quotedId}`));

  const qp = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  const qs = qp.data?.statement || {};
  check(qs.mode === 'quote', 'an unbooked trip produces a quote, not a statement', qs.mode);
  check(/^Your quote:/.test(qp.data?.subject || ''), 'and says so in the subject', qp.data?.subject);
  check(qs.posted?.length === 0 && qs.due?.length === 0 && qs.balanceCents === 0,
    'carrying no payment history and no balance, because there is none',
    JSON.stringify({ posted: qs.posted?.length, due: qs.due?.length, bal: qs.balanceCents }));

  const qhtml = qp.data?.html || '';
  check(!/Received, thank you/.test(qhtml) && !/Still to come/.test(qhtml),
    'and none of the wording that only makes sense once they have booked');
  // A quote that stops at a total leaves the client to work out what happens
  // next, and the commonest answer to that is nothing.
  check(/\$500\.00/.test(qhtml) && /holds this/.test(qhtml),
    'while saying what it takes to hold it, and by when');

  // A quote sent and never followed up is the largest quiet leak in travel
  // sales, and nothing here could even tell you one had been sent.
  const unsent = await call(advisor, 'GET', '/api/dashboard');
  const waiting = (unsent.data?.quotes || []).find((q) => q.id === quotedId);
  check(waiting?.state === 'unsent',
    'a quote written and not sent is waiting on the advisor, not the client',
    JSON.stringify({ state: waiting?.state, days: waiting?.quiet_days }));
  check(!(unsent.data?.quotes || []).some((q) => q.id === stId),
    'and a booked trip is not sitting in the quote follow-up list');

  // Previewing is not sending. Nothing is recorded until the email leaves.
  check(qp.data?.alreadySent === null && qp.data?.sentCount === 0,
    'previewing a quote records nothing');

  const sent = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, {});
  const after = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  if (sent.status === 200) {
    check(after.data?.alreadySent && after.data?.sentCount === 1,
      'a sent quote is remembered, and counted',
      JSON.stringify({ at: after.data?.alreadySent, n: after.data?.sentCount }));
    // Seconds, not milliseconds. Every timestamp in this database is seconds,
    // and one millisecond figure would put a quote sent today fifty thousand
    // years in the past and every quote ever written into the overdue list.
    const dash = await call(advisor, 'GET', '/api/dashboard');
    const row = (dash.data?.quotes || []).find((q) => q.id === quotedId);
    check(!row || row.quiet_days === 0,
      'and a quote sent today is not reported as quiet for decades',
      row && row.quiet_days);
  } else {
    check(after.data?.alreadySent === null,
      'a send that failed records nothing, so nothing looks followed up when it was not',
      `send said ${sent.status}, alreadySent ${after.data?.alreadySent}`);
    console.log('        (email is not configured here, so the send itself cannot be exercised)');
  }

  // Nothing goes out about a trip that is off.
  await call(advisor, 'POST', `/api/bookings/${quotedId}/quick`, { status: 'cancelled' });
  const dead = await call(advisor, 'POST', `/api/bookings/${quotedId}/statement`, { preview: true });
  check(dead.status === 400, 'a cancelled reservation sends nothing at all',
    `status ${dead.status}`);

  const notYours = await call(admin, 'POST', `/api/bookings/${stId}/statement`, { preview: true });
  check(notYours.status === 404,
    'and an owner cannot send a statement over an associate\'s name',
    `status ${notYours.status}`);
  }

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

  // ------------------------------------------------ documents to travel ----
  {
  step('Passports that will stop somebody travelling');

  // Departing in 40 days, home in 50. A passport running out 60 days from now
  // is valid on the day they fly and inside the six month rule on the day they
  // land, which is the case an expiry date alone never catches.
  const soon = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Soon ${stamp}`, supplier: 'Silversea', status: 'booked',
    productName: 'Adriatic', departDate: isoDay(40), returnDate: isoDay(50),
  });
  const soonId = soon.data?.booking?.id;
  if (soonId) cleanup('the documents reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${soonId}`));

  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Rune Short ${stamp}`, passportNumber: 'EXP1', passportExpiry: isoDay(60), isLead: true });
  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Vera Valid ${stamp}`, passportNumber: 'OK1', passportExpiry: isoDay(2000) });
  await call(advisor, 'POST', `/api/bookings/${soonId}/travellers`,
    { name: `Nils Nothing ${stamp}` });

  // The same silence, on a trip far enough out that it is not yet a question.
  const later = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Later ${stamp}`, supplier: 'Silversea', status: 'booked',
    departDate: isoDay(300), returnDate: isoDay(310),
  });
  const laterId = later.data?.booking?.id;
  if (laterId) cleanup('the far off reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${laterId}`));
  await call(advisor, 'POST', `/api/bookings/${laterId}/travellers`,
    { name: `Wilma Waiting ${stamp}` });

  // A quote is not a commitment, so nobody needs chasing for a passport yet.
  const quote = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Docs Quote ${stamp}`, supplier: 'Silversea', status: 'quoted',
    departDate: isoDay(45), returnDate: isoDay(52),
  });
  const quoteId = quote.data?.booking?.id;
  if (quoteId) cleanup('the quoted reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${quoteId}`));
  await call(advisor, 'POST', `/api/bookings/${quoteId}/travellers`,
    { name: `Quinn Quoted ${stamp}` });

  const docs = await call(advisor, 'GET', '/api/documents');
  const by = Object.fromEntries((docs.data?.travellers || []).map((r) => [r.name, r]));

  check(docs.status === 200, 'the document watch answers', `status ${docs.status}`);
  check(by[`Rune Short ${stamp}`]?.kind === 'expiring',
    'a passport inside six months of the return date is raised',
    by[`Rune Short ${stamp}`]?.detail);
  check(/six months/.test(by[`Rune Short ${stamp}`]?.detail || ''),
    'and says why, rather than just flagging a date');

  check(!by[`Vera Valid ${stamp}`], 'a passport good for years is left alone');

  // Silence is not evidence that a client holds a valid passport.
  check(by[`Nils Nothing ${stamp}`]?.kind === 'unknown',
    'a traveller with no passport on a trip leaving soon is raised separately',
    by[`Nils Nothing ${stamp}`]?.detail);

  // The same empty field a year out is normal, and raising it would train
  // whoever reads this panel to stop reading it.
  check(!by[`Wilma Waiting ${stamp}`],
    'while the same silence on a trip ten months out is not a problem yet');
  check(!by[`Quinn Quoted ${stamp}`], 'and a quote is not chased for documents');

  check(docs.data?.counts?.expiring >= 1 && docs.data?.counts?.unknown >= 1,
    'the two kinds are counted apart',
    JSON.stringify(docs.data?.counts));

  // An owner watching the agency sees an associate's travellers; the associate
  // sees only their own, the same rule as everything else.
  const ownerDocs = await call(admin, 'GET', '/api/documents');
  check((ownerDocs.data?.travellers || []).some((r) => r.name === `Rune Short ${stamp}`),
    'an owner sees an associate\'s document problems');

  const onDash = await call(advisor, 'GET', '/api/dashboard');
  check((onDash.data?.documents || []).some((r) => r.name === `Rune Short ${stamp}`),
    'and it reaches the dashboard, which is where it will actually be read');
  check((onDash.data?.panels || []).some((p) => p.id === 'documents'),
    'as a panel that can be arranged like any other');
  }

  // ------------------------------------------------------- birthdays -------
  {
  step('Birthdays, which is what the date of birth was collected for');

  // The month and day of a date some days from now, with a birth year on it.
  // February 29 is stepped over rather than handled: a leap day birthday is a
  // real thing this code skips deliberately, and a test that fails one week in
  // four years is worse than one that does not cover it.
  const birthdayIn = (days, year) => {
    for (const d of [days, days + 1]) {
      const md = isoDay(d).slice(5);
      if (md !== '02-29') return `${year}-${md}`;
    }
    return `${year}-01-01`;
  };

  const bTrip = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Birthday ${stamp}`, supplier: 'Azamara', status: 'travelled',
    departDate: isoDay(-90), returnDate: isoDay(-80),
  });
  const bId = bTrip.data?.booking?.id;
  if (bId) cleanup('the birthday reservation', () => call(advisor, 'DELETE', `/api/bookings/${bId}`));

  const soonBirthday = birthdayIn(5, 1975);
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Soon ${stamp}`, dob: soonBirthday, email: `cake-${stamp}@example.com`, isLead: true });
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Later ${stamp}`, dob: birthdayIn(200, 1980) });
  // Yesterday's birthday rolls to next year, which is not "in the next month".
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `Cake Passed ${stamp}`, dob: birthdayIn(-1, 1990) });
  await call(advisor, 'POST', `/api/bookings/${bId}/travellers`,
    { name: `No Date ${stamp}` });

  // The same person on a second trip, because four sailings is four traveller
  // rows and one birthday.
  const bTrip2 = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Birthday ${stamp}`, supplier: 'Azamara', status: 'booked',
    departDate: isoDay(120), returnDate: isoDay(130),
  });
  const bId2 = bTrip2.data?.booking?.id;
  if (bId2) cleanup('the second birthday reservation',
    () => call(advisor, 'DELETE', `/api/bookings/${bId2}`));
  await call(advisor, 'POST', `/api/bookings/${bId2}/travellers`,
    { name: `Cake Soon ${stamp}`, dob: soonBirthday });

  const dash = await call(advisor, 'GET', '/api/dashboard');
  const cakes = (dash.data?.birthdays || []).filter((r) => r.name.endsWith(stamp));
  const soon = cakes.find((r) => r.name === `Cake Soon ${stamp}`);

  check(soon, 'a birthday in the next few days is listed', JSON.stringify(cakes.map((c) => c.name)));
  check(soon?.in_days >= 4 && soon?.in_days <= 7,
    'with how many days away it is', soon?.in_days);
  check(soon?.turning === Number(soon?.on?.slice(0, 4)) - 1975,
    'and the age they are turning, worked from the year on file', soon?.turning);

  check(cakes.filter((r) => r.name === `Cake Soon ${stamp}`).length === 1,
    'somebody who has sailed twice appears once, not twice');
  check(!cakes.some((r) => r.name === `Cake Later ${stamp}`),
    'a birthday half a year out is not in the next month');
  check(!cakes.some((r) => r.name === `Cake Passed ${stamp}`),
    'and one that has just gone rolls to next year rather than reading as due');
  check(!cakes.some((r) => r.name === `No Date ${stamp}`),
    'a traveller with no date of birth is not guessed at');
  }

  // -------------------------------------------------- commission split -----
  // Deliberately last but one: it changes what this advisor is recorded as
  // keeping, and every earlier check reads those same figures. Cleared again
  // at the end of the section.
  {
  step('Splitting a commission between the advisor and the agency');

  // 333.33 at half is 16,666.5 cents. The point of the figure: SQLite rounds
  // it in the reports and JavaScript rounds it on the record, and the two must
  // land on the same cent or the screens disagree about somebody's pay.
  const half = await call(advisor, 'POST', '/api/bookings', {
    clientName: `Split ${stamp}`, supplier: 'Celebrity Cruises', status: 'booked',
    departDate: isoDay(60), returnDate: isoDay(67), gross: '4000', commission: '333.33',
  });
  const halfId = half.data?.booking?.id;
  if (halfId) cleanup('the split reservation', () => call(advisor, 'DELETE', `/api/bookings/${halfId}`));

  const noDeal = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(noDeal.data?.split?.pct === 100 && noDeal.data?.split?.advisorCents === 33333,
    'with no agreement an advisor keeps what they billed',
    JSON.stringify(noDeal.data?.split));

  // An associate who could set their own share could pay themselves.
  const selfServe = await call(advisor, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 90 });
  check(selfServe.status === 403 || selfServe.status === 404,
    'an advisor cannot set their own share', `status ${selfServe.status}`);

  const nonsense = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 140 });
  check(nonsense.status === 400, 'and a share over 100% is refused', `status ${nonsense.status}`);

  const agreed = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: 50 });
  check(agreed.status === 200 && agreed.data?.user?.defaultSplitPct === 50,
    'the owner sets a standing agreement', agreed.data?.user?.defaultSplitPct);

  const onDeal = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  const sp = onDeal.data?.split || {};
  check(sp.pct === 50 && sp.overridden === false,
    'which every trip follows without being touched',
    JSON.stringify({ pct: sp.pct, overridden: sp.overridden }));
  check(sp.advisorCents + sp.agencyCents === 33333,
    'and the two halves add back up to the commission exactly',
    `${sp.advisorCents} + ${sp.agencyCents}`);
  check(sp.advisorCents === 16667, 'rounding the odd cent to the advisor', sp.advisorCents);

  // The same figure, computed by SQLite rather than JavaScript.
  const comm = await call(advisor, 'GET', '/api/commissions');
  const commRow = (comm.data?.rows || []).find((r) => r.id === halfId);
  check(commRow?.advisor_cents === sp.advisorCents,
    'the report and the record agree to the cent',
    `${commRow?.advisor_cents} vs ${sp.advisorCents}`);
  check(comm.data?.anySplit === true, 'and the page knows there is a split to show');

  // A trip can carry its own figure, and blank puts it back on the agreement.
  await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { advisorSplitPct: 80 });
  const over = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(over.data?.split?.pct === 80 && over.data?.split?.overridden === true,
    'one trip can be given its own share', JSON.stringify(over.data?.split));
  await call(advisor, 'POST', `/api/bookings/${halfId}/quick`, { advisorSplitPct: '' });
  const back = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(back.data?.split?.pct === 50 && back.data?.split?.overridden === false,
    'and clearing it puts the trip back on the agreement, not on nothing',
    JSON.stringify(back.data?.split));

  // Nought is a real arrangement and must not be read as "no agreement".
  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: 0 });
  const houseAccount = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(houseAccount.data?.split?.pct === 0 && houseAccount.data?.split?.advisorCents === 0,
    'an advisor on nought keeps nothing, which is not the same as no agreement',
    JSON.stringify(houseAccount.data?.split));

  const cleared = await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`,
    { defaultSplitPct: '' });
  check(cleared.data?.user?.defaultSplitPct === null,
    'and blank clears the agreement rather than setting it to nought',
    cleared.data?.user?.defaultSplitPct);
  const afterClear = await call(advisor, 'GET', `/api/bookings/${halfId}/record`);
  check(afterClear.data?.split?.pct === 100,
    'which puts them back on keeping all of it', afterClear.data?.split?.pct);

  // An owner reading the combined report sees both sides of the same money.
  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: 50 });
  const rep = await call(admin, 'GET', '/api/reports/production?months=12');
  const line = (rep.data?.byAdvisor || []).find((r) => r.user_id === advisorId);
  if (line) {
    check(line.advisor_share_cents + line.agency_share_cents === line.commission_cents,
      'the combined report splits the same total, never more than it',
      `${line.advisor_share_cents} + ${line.agency_share_cents} vs ${line.commission_cents}`);
    check(line.advisor_share_cents < line.commission_cents,
      'and an associate on a split is not credited with the agency\'s half',
      `${line.advisor_share_cents} of ${line.commission_cents}`);
  } else {
    check(false, 'the combined report lists the associate');
  }

  await call(admin, 'PUT', `/api/admin/advisors/${advisorId}/split`, { defaultSplitPct: '' });
  }

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
      (skips.length ? ` ${skips.length} section${skips.length === 1 ? '' : 's'} skipped: ${
        skips.join(', ')}.` : '') +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
    process.exit(failures ? 1 : 0);
  });
