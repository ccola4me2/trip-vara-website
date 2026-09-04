// The remaining Trip Vara Tools areas, grouped into a few coherent endpoints
// rather than one route per upstream resource.
//
// Every section is fetched independently and allowed to fail on its own. These
// pages pull from many resources at once, and one unavailable area should cost
// its own panel rather than the whole screen.

import { json } from './util.js';
import { requireUser } from './auth.js';
import * as ghl from './ghl.js';

/** Runs the named loaders in parallel, never throwing. */
async function gather(entries) {
  const out = {};
  const unavailable = {};
  const settled = await Promise.all(
    entries.map(async ([key, run]) => {
      try { return [key, await run(), null]; }
      catch (e) { return [key, null, e]; }
    })
  );
  for (const [key, value, err] of settled) {
    out[key] = value ?? (Array.isArray(value) ? [] : null);
    if (err) { out[key] = Array.isArray(out[key]) ? [] : null; unavailable[key] = true; }
  }
  return { out, unavailable };
}

export async function handleMarketing(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['funnels', () => ghl.listFunnels(env, loc)],
    ['campaigns', () => ghl.listCampaigns(env, loc)],
    ['emailTemplates', () => ghl.listEmailTemplates(env, loc)],
    ['triggerLinks', () => ghl.listTriggerLinks(env, loc)],
    ['socialAccounts', () => ghl.listSocialAccounts(env, loc)],
    ['socialPosts', () => ghl.listSocialPosts(env, loc)],
    ['blogSites', () => ghl.listBlogSites(env, loc)],
  ]);

  // Blog posts need a site id, so they can only be fetched once sites are in.
  let blogPosts = [];
  if (Array.isArray(out.blogSites) && out.blogSites.length) {
    blogPosts = await ghl.listBlogPosts(env, loc, out.blogSites[0].id).catch(() => []);
  }

  return json({ ...out, blogPosts, unavailable });
}

export async function handleCatalog(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['products', () => ghl.listProducts(env, loc)],
  ]);

  // Prices hang off each product. Cap the fan-out so a large catalogue does
  // not fire a hundred requests and trip the rate limit.
  const products = out.products || [];
  const withPrices = await Promise.all(
    products.slice(0, 25).map(async (p) => ({
      ...p,
      prices: await ghl.listProductPrices(env, loc, p.id).catch(() => []),
    }))
  );
  const rest = products.slice(25).map((p) => ({ ...p, prices: [] }));

  return json({ products: [...withPrices, ...rest], unavailable });
}

export async function handleLibrary(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);
  const { out, unavailable } = await gather([['files', () => ghl.listMedia(env, loc)]]);
  return json({ files: out.files || [], unavailable });
}

export async function handleAccount(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);

  const { out, unavailable } = await gather([
    ['location', () => ghl.getLocation(env, loc)],
    ['users', () => ghl.listUsers(env, loc)],
    ['customFields', () => ghl.listCustomFields(env, loc)],
    ['customValues', () => ghl.listCustomValues(env, loc)],
    ['tags', () => ghl.listTags(env, loc)],
    ['customObjects', () => ghl.listCustomObjects(env, loc)],
    ['businesses', () => ghl.listBusinesses(env, loc)],
  ]);
  return json({ ...out, unavailable });
}

export async function handleSurveys(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  const loc = ghl.locationFor(env, user);
  const url = new URL(request.url);

  try {
    const [surveys, submissions] = await Promise.all([
      ghl.listSurveys(env, loc),
      ghl.listSurveySubmissions(env, loc, {
        surveyId: url.searchParams.get('surveyId') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
    ]);
    const byId = new Map(surveys.map((sv) => [sv.id, sv.name]));
    for (const sub of submissions.submissions) sub.surveyName = byId.get(sub.surveyId) || '';
    return json({ surveys, ...submissions });
  } catch (e) {
    return ghl.ghlErrorResponse(e);
  }
}
