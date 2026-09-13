// Does an email still say what it has to say once it is rendered?
//
// Everything else in this repository checks the code. This checks the one
// artifact that leaves it: the message a client opens.
//
// The plain-text alternative is the half nobody looks at. It is sent alongside
// the HTML, it is what a reader set to plain text and a good number of spam
// filters actually see, and it is built by stripping tags out of the HTML. So
// a change to the markup can quietly ruin it while the HTML still looks right
// in a preview.
//
// The other half is the link somebody pastes into a message. It is text a
// person typed and it ends up inside an href, so escaping has to run before
// linkifying or a quote in the address closes the attribute it lands in.
//
// The CTT fork carries more of these, for the marketing footer this portal
// does not have.
//
//   node scripts/check-email.mjs

import { layout, plainText, linkify, escapeHtml } from '../src/email.js';
import { annotate } from './lib/annotate.mjs';

const env = { APP_URL: 'https://example.test' };

const transactional = layout(env, {
  heading: 'Payment due',
  body: '<p style="margin:0;">The balance for your trip is due on 26 September.</p>',
});
const transactionalText = plainText(transactional);

const pasted = 'Book here: https://example.test/s/ALASKA26. Reply if you want it.';
const linked = linkify(escapeHtml(pasted));
const linkedText = plainText(`<p>${linked}</p>`);
const injection = linkify(escapeHtml('https://x.test/a"onmouseover="alert(1)'));

const checks = [
  ['the plain text alternative has no markup left in it', !/<[a-z/]/i.test(transactionalText)],
  ['and is not empty', transactionalText.trim().length > 30],
  ['a pasted link becomes clickable',
    linked.includes('<a href="https://example.test/s/ALASKA26"')],
  ['and the sentence it sits in keeps its full stop outside the link',
    linked.includes('</a>. Reply')],
  ['and the text alternative does not print the address twice',
    linkedText.includes('ALASKA26. Reply') && !linkedText.includes('(https://example.test')],
  // The assertion that matters most: the body is text a person typed and it
  // ends up inside an href.
  ['a quote in a pasted URL cannot break out of the attribute',
    !/href="[^"]*"[^>]*on\w+=/i.test(injection) && injection.includes('&quot;')],
  // This portal sends nothing that a client could reasonably not want, so no
  // message it produces should offer a way out of receiving them.
  ['a transactional email offers no way to unsubscribe',
    !/unsubscribe/i.test(transactionalText)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}`);
  if (!ok) {
    failed += 1;
    annotate('Email render', label);
  }
}

console.log('');
if (failed) {
  console.log(`${failed} of ${checks.length} things a rendered email must do are not done.`);
  process.exit(1);
}
console.log(`check-email: all ${checks.length} render checks pass`);
