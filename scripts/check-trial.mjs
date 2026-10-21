// Which demo notice is due, on every day of the trial.
//
// This function has been wrong once already, and it was wrong in a way reading
// it did not reveal. `TRIAL_NOTICES` was written widest first, the search took
// the first entry a day qualified for, and so a trial one day from ending
// looked like it was due the widest notice, saw that one had already gone, and
// said nothing at all for the rest of the trial. A prospect opened the portal
// one morning to find it shut, with no warning.
//
// It is also the function that has to move whenever the trial length does,
// which is exactly when a schedule quietly stops making sense: a seven day
// notice on a seven day trial fires the moment somebody signs up.
//
// So: a day by day table rather than an argument. Every day of the trial, in
// order, with what each one should send and what it should stay silent about.
//
//   node scripts/check-trial.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate } from './lib/annotate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { noticeFor, TRIAL_NOTICES, TRIAL_ENDED, TRIAL_DAYS } =
  await import(join(ROOT, 'src', 'demo.js'));

let checks = 0;
let failures = 0;

function check(condition, label, detail) {
  checks += 1;
  if (condition) { console.log(`  ok    ${label}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
  annotate('Trial notices', detail === undefined ? label : `${label} -- ${detail}`);
  return false;
}

const DAY = 86400;
const NOW = 1800000000;
// A trial that ends N days from now.
const endsIn = (days) => NOW + (days * DAY);

console.log('\nThe schedule itself');
check(TRIAL_DAYS > 0, 'the trial has a length', `${TRIAL_DAYS}`);
check(TRIAL_NOTICES.length > 0, 'and at least one notice before it ends');
check(Math.max(...TRIAL_NOTICES) < TRIAL_DAYS,
  'every notice is inside the trial, so none fires on the day somebody signs up',
  `widest notice ${Math.max(...TRIAL_NOTICES)} against a ${TRIAL_DAYS} day trial`);
check(new Set(TRIAL_NOTICES).size === TRIAL_NOTICES.length, 'with no duplicates');
check(!TRIAL_NOTICES.includes(TRIAL_ENDED),
  'and the ended notice is not one of them, because it is not days of notice');

console.log('\nNothing sent before the first notice is due');
const widest = Math.max(...TRIAL_NOTICES);
for (let d = TRIAL_DAYS; d > widest; d -= 1) {
  check(noticeFor(endsIn(d), NOW, null) === null,
    `${d} days out: silent`, String(noticeFor(endsIn(d), NOW, null)));
}

console.log('\nEach notice fires on its own day, closest first');
for (const n of [...TRIAL_NOTICES].sort((a, b) => b - a)) {
  check(noticeFor(endsIn(n), NOW, null) === n,
    `${n} days out with nothing sent yet: the ${n} day notice`,
    String(noticeFor(endsIn(n), NOW, null)));
}

console.log('\nAnd never the same one twice');
for (const n of TRIAL_NOTICES) {
  check(noticeFor(endsIn(n), NOW, n) === null,
    `${n} days out having already had it: silent`,
    String(noticeFor(endsIn(n), NOW, n)));
}

console.log('\nA closer day still speaks, which is the bug this check exists for');
const ordered = [...TRIAL_NOTICES].sort((a, b) => b - a);
for (let i = 1; i < ordered.length; i += 1) {
  const closer = ordered[i];
  const alreadySent = ordered[i - 1];
  check(noticeFor(endsIn(closer), NOW, alreadySent) === closer,
    `${closer} days out having had the ${alreadySent} day one: the ${closer} day notice`,
    String(noticeFor(endsIn(closer), NOW, alreadySent)));
}

console.log('\nThe day it ends, and after');
check(noticeFor(endsIn(0), NOW, null) === TRIAL_ENDED, 'the day it ends: the ended notice');
check(noticeFor(NOW - DAY, NOW, null) === TRIAL_ENDED, 'a day late: still the ended notice');
check(noticeFor(NOW - (30 * DAY), NOW, null) === TRIAL_ENDED, 'a month late: still, once');
check(noticeFor(endsIn(0), NOW, TRIAL_ENDED) === null, 'and not twice');
check(noticeFor(NOW - (30 * DAY), NOW, TRIAL_ENDED) === null, 'however long ago it was');
check(noticeFor(endsIn(0), NOW, Math.min(...TRIAL_NOTICES)) === TRIAL_ENDED,
  'having had the last warning does not swallow the ended one',
  String(noticeFor(endsIn(0), NOW, Math.min(...TRIAL_NOTICES))));

console.log('\nNo trial, nothing to say');
check(noticeFor(null, NOW, null) === null, 'an agency with no end date is silent');
check(noticeFor(0, NOW, null) === null, 'and so is one with a zero');
check(noticeFor(undefined, NOW, null) === null, 'and so is one with nothing at all');

console.log('\nExtending it starts the notices over');
// The one way this could surprise somebody a second time: a trial pushed back
// past the widest notice must go quiet again until it comes round.
check(noticeFor(endsIn(TRIAL_DAYS), NOW, Math.min(...TRIAL_NOTICES)) === null,
  'a trial put back to its full length says nothing yet',
  String(noticeFor(endsIn(TRIAL_DAYS), NOW, Math.min(...TRIAL_NOTICES))));

console.log(failures
  ? `\n${failures} of ${checks} trial notice checks failed.`
  : `\ncheck-trial: all ${checks} trial notice checks passed, over a ${TRIAL_DAYS} day trial.`);
process.exit(failures ? 1 : 0);
