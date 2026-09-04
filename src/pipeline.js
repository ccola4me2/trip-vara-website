// Pipeline and opportunities, read and written through to GoHighLevel.

import { json, badRequest, clean, oneOf, readJson } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';
import { logActivity } from './db.js';

const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'];

export async function handleListPipelines(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  try {
    return json({ pipelines: await ghl.listPipelines(env, ghl.locationFor(env, user)) });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

/**
 * Opportunities for one pipeline, already grouped by stage so the board can
 * render without a second pass. Falls back to the first pipeline when none is
 * named, which is what the board wants on first load.
 */
export async function handleListOpportunities(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const locationId = ghl.locationFor(env, user);

  try {
    const pipelines = await ghl.listPipelines(env, locationId);
    if (!pipelines.length) return json({ pipelines: [], pipeline: null, stages: [], opportunities: [] });

    const wanted = url.searchParams.get('pipelineId');
    const pipeline = pipelines.find((p) => p.id === wanted) || pipelines[0];

    const { opportunities, total } = await ghl.searchOpportunities(env, locationId, {
      pipelineId: pipeline.id,
      status: url.searchParams.get('status') || undefined,
      query: url.searchParams.get('q') || undefined,
      limit: 100,
    });

    // Group into the pipeline's stage order, with anything unstaged last.
    const byStage = new Map(pipeline.stages.map((s) => [s.id, []]));
    const unstaged = [];
    for (const opp of opportunities) {
      const bucket = byStage.get(opp.stageId);
      if (bucket) bucket.push(opp); else unstaged.push(opp);
    }

    const stages = pipeline.stages.map((s) => {
      const items = byStage.get(s.id) || [];
      return {
        ...s,
        count: items.length,
        valueTotal: items.reduce((sum, o) => sum + o.monetaryValue, 0),
        opportunities: items,
      };
    });
    if (unstaged.length) {
      stages.push({
        id: null,
        name: 'Unstaged',
        position: 999,
        count: unstaged.length,
        valueTotal: unstaged.reduce((sum, o) => sum + o.monetaryValue, 0),
        opportunities: unstaged,
      });
    }

    return json({
      pipelines: pipelines.map(({ id, name }) => ({ id, name })),
      pipeline: { id: pipeline.id, name: pipeline.name },
      stages,
      total,
    });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleCreateOpportunity(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const name = clean(body.name, 160);
  if (!name) return badRequest('Give the opportunity a name.');
  if (!body.pipelineId) return badRequest('Choose a pipeline.');
  if (!body.contactId) return badRequest('Attach a contact.');

  try {
    const opportunity = await ghl.createOpportunity(env, ghl.locationFor(env, user), {
      name,
      pipelineId: body.pipelineId,
      stageId: body.stageId,
      contactId: body.contactId,
      status: oneOf(body.status, OPP_STATUSES),
      monetaryValue: body.monetaryValue,
      assignedTo: user.ghl_user_id || undefined,
    });
    await logActivity(env, user.id, 'opportunity.create', `Created ${name}`, { id: opportunity.id });
    return json({ ok: true, opportunity }, 201);
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}

export async function handleUpdateOpportunity(request, env, opportunityId) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const body = await readJson(request);
  const fields = {};
  if (body.name !== undefined) fields.name = clean(body.name, 160);
  if (body.stageId !== undefined) fields.stageId = body.stageId;
  if (body.monetaryValue !== undefined) fields.monetaryValue = body.monetaryValue;
  if (body.status !== undefined) fields.status = oneOf(body.status, OPP_STATUSES);
  if (!Object.keys(fields).length) return badRequest('Nothing to update.');

  try {
    const opportunity = await ghl.updateOpportunity(env, opportunityId, fields);
    await logActivity(env, user.id, 'opportunity.update', `Updated ${opportunity.name}`, {
      id: opportunityId, ...fields,
    });
    return json({ ok: true, opportunity });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
