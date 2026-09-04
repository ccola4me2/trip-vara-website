// Deep links into GoHighLevel.
//
// Some of the sub-account has no API worth building against: the funnel
// builder, the workflow editor, the email builder. Rather than leave an
// advisor at a dead end, the portal points straight at those screens, already
// scoped to their location.
//
// The paths live in one array on purpose. GHL moves them occasionally, and a
// wrong one should be a one-line fix rather than a hunt.

import { json } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', path: 'dashboard',
    note: 'The sub-account home in GoHighLevel.' },
  { key: 'workflows', label: 'Workflows', path: 'automation/workflows',
    note: 'Build and edit automations. The portal can add a contact to one, but not author it.' },
  { key: 'funnels', label: 'Funnels & websites', path: 'funnels-websites/funnels',
    note: 'Page and funnel builder.' },
  { key: 'emails', label: 'Email builder', path: 'emails/campaigns',
    note: 'Compose and schedule email campaigns.' },
  { key: 'formBuilder', label: 'Form builder', path: 'form-builder-v2/list',
    note: 'Create and edit forms. Submissions are readable in the portal.' },
  { key: 'social', label: 'Social planner', path: 'social-planner/planner',
    note: 'Schedule social posts.' },
  { key: 'reputation', label: 'Reputation', path: 'reputation/reviews',
    note: 'Review requests and responses.' },
  { key: 'payments', label: 'Payments & invoices', path: 'payments/v2/invoices',
    note: 'Raise invoices. The portal shows them read-only under Billing.' },
  { key: 'settings', label: 'Sub-account settings', path: 'settings/company',
    note: 'Numbers, integrations, custom fields and everything else.' },
];

export async function handleCrmLinks(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const base = (env.GHL_APP_BASE || 'https://app.concinnity.digital').replace(/\/$/, '');
  const locationId = ghl.locationFor(env, user);

  return json({
    locationId,
    base,
    sections: SECTIONS.map((s) => ({
      key: s.key,
      label: s.label,
      note: s.note,
      href: `${base}/v2/location/${encodeURIComponent(locationId)}/${s.path}`,
    })),
  });
}
