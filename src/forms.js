// Forms, submissions and workflow triggers.
//
// Workflows are listed and contacts can be pushed into one. Authoring a
// workflow has no API and stays in GoHighLevel, which is what the deep links
// on the GoHighLevel page are for.

import { json, badRequest, clean, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import { logActivity } from './db.js';

export async function handleListForms(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const locationId = ghl.locationFor(env, user);

  try {
    const [forms, submissions] = await Promise.all([
      ghl.listForms(env, locationId),
      ghl.listFormSubmissions(env, locationId, {
        formId: url.searchParams.get('formId') || undefined,
        q: url.searchParams.get('q') || undefined,
        limit: 50,
      }),
    ]);

    // Name submissions by their form where the submission itself omits it.
    const byId = new Map(forms.map((f) => [f.id, f.name]));
    for (const s of submissions.submissions) {
      if (!s.formName && s.formId) s.formName = byId.get(s.formId) || '';
    }

    return json({ forms, ...submissions });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleListWorkflows(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  try {
    return json({ workflows: await ghl.listWorkflows(env, ghl.locationFor(env, user)) });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleAddToWorkflow(request, env, contactId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const workflowId = clean(body.workflowId, 64);
  if (!workflowId) return badRequest('Choose a workflow.');

  try {
    await ghl.addContactToWorkflow(env, contactId, workflowId);
    await logActivity(env, user.id, 'workflow.add',
      `Added a contact to ${clean(body.workflowName, 120) || 'a workflow'}`, { contactId, workflowId });
    return json({ ok: true }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
