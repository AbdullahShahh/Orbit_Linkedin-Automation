// Prospect finder: searches LinkedIn posts and jobs for people / companies that need lead generation,
// outbound, cold email or email marketing help, and keeps only the ones that pass every check:
//   quality filter (prospects/filter.js) -> not a duplicate -> has a person or company ->
//   author / job location is known and not in a blocked country (Settings).
// Everything that is dropped is stored as "rejected" with the reason, so it's never processed twice
// and you can audit the filter on the Prospects screen.
const { db, getSettings, prospectCap } = require('../db');
const { logger, emit } = require('../logger');
const { ageDays, judgePost, judgeJob, judgeJobDetail, companyFromHeadline } = require('../prospects/filter');
const { checkBlocked, checkTarget, countryOf, mentionsBlocked, parseCountries } = require('../location');
const bridge = require('./bridge');
const { judgeWithClaude } = require('../prospects/ai');
const safety = require('./safety');

// LinkedIn answering 429 / 999 = "too many requests": stop and wait instead of pushing on
function checkRateLimit(msg = '', loggedIn = true) {
  if (/\b(429|999)\b/.test(msg) && /answered|readable|status/i.test(msg)) {
    throw new safety.RateLimitError(loggedIn ? `LinkedIn is limiting requests (${msg})` : `LinkedIn's public pages are limiting requests (${msg})`, loggedIn ? undefined : 1, !loggedIn);
  }
}

const COUNTRY_ORDER = ['netherlands', 'germany', 'ireland', 'denmark', 'sweden', 'finland', 'norway', 'belgium', 'switzerland',
  'austria', 'spain', 'portugal', 'poland', 'estonia', 'czech republic'];

const MAX_AGE_DAYS = 7; // posts and jobs older than a week are never kept
const POST_WINDOW = { day: 'past-24h', week: 'past-week', month: 'past-month' };
const JOB_WINDOW = { day: 'r86400', week: 'r604800', month: 'r2592000' };

// LinkedIn's own job filters
const WORKPLACE = { onsite: 1, remote: 2, hybrid: 3 };
const LEVEL = { internship: 1, entry: 2, associate: 3, mid: 4, director: 5, executive: 6 };
const JOBTYPE = { full: 'F', part: 'P', contract: 'C', temporary: 'T', internship: 'I', volunteer: 'V' };
const codes = (list = [], map) => list.map((x) => map[x]).filter(Boolean).join(',');

function searchUrl(s) {
  const q = encodeURIComponent(s.keywords);
  const f = s.f || {};
  if (s.kind === 'jobs') {
    const loc = s.location ? `&location=${encodeURIComponent(s.location)}` : '';
    const st = getSettings();
    let extra = '';
    if (s.f) {
      if (codes(f.workplace, WORKPLACE)) extra += `&f_WT=${encodeURIComponent(codes(f.workplace, WORKPLACE))}`;
      if (codes(f.levels, LEVEL)) extra += `&f_E=${encodeURIComponent(codes(f.levels, LEVEL))}`;
      if (codes(f.jobTypes, JOBTYPE)) extra += `&f_JT=${encodeURIComponent(codes(f.jobTypes, JOBTYPE))}`;
      if (f.easyApply) extra += '&f_AL=true';
      if (f.fewApplicants) extra += '&f_EA=true';
      if (f.sort === 'recent') extra += '&sortBy=DD';
    } else if (globalAll(st) || parseCountries(st.prospect_global_only).includes(countryOf(s.location))) {
      extra = '&f_WT=2'; // older searches: only remote jobs are worth reading
    }
    return `https://www.linkedin.com/jobs/search/?keywords=${q}${loc}&f_TPR=${JOB_WINDOW[s.date_window] || JOB_WINDOW.week}${extra}`;
  }
  const sort = f.sort === 'relevance' ? 'relevance' : 'date_posted';
  const author = words(f.authorTitles).length ? `&authorJobTitle=${encodeURIComponent(`"${words(f.authorTitles).join(' OR ')}"`)}` : '';
  return `https://www.linkedin.com/search/results/content/?keywords=${q}&datePosted=${encodeURIComponent(`"${POST_WINDOW[s.date_window] || POST_WINDOW.week}"`)}&sortBy=${encodeURIComponent(`"${sort}"`)}${author}`;
}

const words = (list = []) => (Array.isArray(list) ? list : String(list).split(',')).map((w) => String(w).trim()).filter(Boolean);
function filtersOf(s) {
  if (!s.filters) return null;
  try { return JSON.parse(s.filters); } catch { return null; }
}

/**
 * A saved search becomes one or more LinkedIn searches ("parts"):
 *   jobs  – every job title × every location
 *   posts – every keyword / phrase
 * Older searches (no filters) are one part with their own keywords / location.
 */
function partsOf(s) {
  const f = filtersOf(s);
  if (!f) return [{ ...s, f: null, label: s.name }];
  if (s.kind === 'jobs') {
    const titles = words(f.titles);
    const locs = words(f.locations).length ? words(f.locations) : [''];
    const remoteOnly = words(f.workplace).length === 1 && f.workplace[0] === 'remote';
    return titles.flatMap((t) => locs.map((l) => ({
      ...s, f, keywords: remoteOnly ? `${t} remote` : t, location: l, max_results: f.maxResults || s.max_results,
      label: `${s.name}: ${t}${l ? ` · ${l}` : ''}`,
    })));
  }
  return words(f.keywords).map((k) => ({
    ...s, f, keywords: f.exact === false ? k : `"${k}"`, max_results: f.maxResults || s.max_results,
    label: `${s.name}: ${k}`,
  }));
}

const exists = (key) => !!db.prepare('SELECT 1 FROM prospects WHERE source_key = ?').get(key);

const insert = db.prepare(`INSERT OR IGNORE INTO prospects
  (search_id, kind, source_key, url, person_name, person_url, headline, company_name, company_url, location, title, text, posted, score, reasons, status, reject_reason, job_id, job_title, job_info)
  VALUES (@search_id, @kind, @source_key, @url, @person_name, @person_url, @headline, @company_name, @company_url, @location, @title, @text, @posted, @score, @reasons, @status, @reject_reason, @job_id, @job_title, @job_info)`);

function save(row) {
  const full = {
    url: '', person_name: '', person_url: '', headline: '', company_name: '', company_url: '', location: '', title: '',
    text: '', posted: '', score: 0, reasons: '', reject_reason: '', job_id: '', job_title: '', job_info: '', ...row,
  };
  // rejected rows only need enough to audit the decision
  if (full.status === 'rejected') full.text = full.text.slice(0, 600);
  insert.run(full);
}

// "All countries" in Settings -> every job must be remote and open to applicants anywhere
const globalAll = (st) => /^\s*(all( countries)?|every( country)?|everywhere|any|\*)\s*$/i.test(String(st.prospect_global_only || ''));
const cvWords = (st) => String(st.prospect_cv_keywords || '').split(',').map((w) => w.trim()).filter(Boolean);
/**
 * Runs an action in the bot tab. Chrome freezes background tabs (in a collapsed tab group within
 * seconds) and nothing runs in a frozen tab – a fresh page load wakes it up. So the tab is first
 * loaded with a tiny linkedin.com page, then the action runs right away; if it still hangs, once more.
 */
let lastWake = 0;
async function wakeWork() {
  await bridge.call('navigate', { tab: TABS.work, url: LIGHT_PAGE, settle: 0.3 }, 60000);
  lastWake = Date.now();
}
async function execWork(action, args = [], timeout = 30000) {
  if (Date.now() - lastWake > 2500) await wakeWork();
  const loggedIn = /^postSearch/.test(action); // the post search uses your login, the rest are public pages
  try {
    const res = await bridge.call('exec', { tab: TABS.work, action, args }, timeout);
    if (res && res.error) checkRateLimit(res.error, loggedIn);
    return res;
  } catch (e) {
    checkRateLimit(e.message, loggedIn);
    if (!/did not respond/i.test(e.message)) throw e;
    logger.info(`The bot tab was asleep (${action}) – waking it`);
    await wakeWork();
    return bridge.call('exec', { tab: TABS.work, action, args }, timeout);
  } finally {
    lastWake = Date.now();
  }
}

// The prospect finder's own bot tabs (campaigns use 'work' + 'job'), so both can run at once
const TABS = { work: 'pwork', job: 'pjob' };
const LIGHT_PAGE = 'https://www.linkedin.com/robots.txt';
const randBetween = (a, b) => Math.min(a, b) + Math.random() * Math.abs(b - a);

// Daily caps from Settings (new prospects kept today, per kind; daily limit + today's extra)
const keptToday = (kind) => db.prepare("SELECT COUNT(*) c FROM prospects WHERE kind = ? AND status != 'rejected' AND date(found_at) = date('now','localtime')").get(kind).c;
function capReached(kind) {
  const cap = prospectCap(kind);
  return cap > 0 && keptToday(kind) >= cap ? cap : 0;
}

/**
 * Runs the given searches. ctx comes from the runner:
 *   wait(seconds, reason)  interruptible wait (pause / stop aware)
 *   checkpoint()           throws when Stop was pressed
 *   setStep(search, text)  shows what is happening on the dashboard
 */
async function runSearches(searchIds, ctx) {
  let searches = db.prepare('SELECT * FROM prospect_searches WHERE active = 1 ORDER BY id').all();
  if (searchIds && searchIds.length) searches = searches.filter((s) => searchIds.includes(s.id));
  if (!searches.length) throw new Error('No active prospect searches selected');
  // Posts first, then jobs country by country in COUNTRY_ORDER, then wider (EU) searches, UK always last
  const rank = (s) => {
    if (s.kind !== 'jobs') return -1;
    const c = countryOf(s.location);
    if (c === 'united kingdom') return 1000;
    const i = COUNTRY_ORDER.indexOf(c);
    return i === -1 ? 500 : i;
  };
  const parts = searches.flatMap(partsOf).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  if (!parts.length) throw new Error('The selected searches have no job titles / keywords');
  // Can the extension search in its background worker (no tab)? Older extensions can't – then a tab is used.
  bgOk = true;
  try { await bridge.call('bg', { action: 'parseJobList', args: [''] }, 15000); } catch (e) {
    bgOk = false;
    logger.warn('Reload the "LinkedIn Bot" extension (chrome://extensions) – then prospect searches run without any tab and alongside campaigns');
    await bridge.call('useWorkTab', { role: TABS.work });
  }
  // While a campaign is sending, posts wait (they open profiles with your account) – jobs go first
  const busy = () => (ctx.campaignBusy ? ctx.campaignBusy() : false);
  if (busy()) parts.sort((a, b) => (a.kind === 'jobs' ? 0 : 1) - (b.kind === 'jobs' ? 0 : 1));
  let toldWaiting = false;
  const capTold = {};

  const total = { kept: 0, read: 0 };
  const bySearch = {}; // totals per saved search, for its "last result"
  // A part that fails (laptop went to sleep, Chrome stopped answering…) is tried once more at the end
  const queue = parts.map((s) => ({ s, retry: false }));
  for (let i = 0; i < queue.length; i++) {
    await ctx.checkpoint();
    const { s, retry, deferred } = queue[i];
    s.done = Math.min(i + 1, parts.length);
    s.total = parts.length;
    if (s.kind !== 'jobs' && busy()) {
      if (!deferred) {
        if (!toldWaiting) logger.info('A campaign is sending connection notes – post searches wait until it is done (jobs keep going)');
        toldWaiting = true;
        queue.push({ s, retry, deferred: true });
        continue;
      }
      logger.info(`Prospects "${s.label}": skipped – the campaign is still sending (posts run when it's done)`);
      continue;
    }
    if (retry) {
      logger.info(`Prospects "${s.label}": trying again`);
      await waitForBrowser(ctx);
    }
    const jobsCool = s.kind === 'jobs' && safety.cooldown('jobs');
    if (jobsCool) {
      logger.info(`Prospects "${s.label}": skipped – LinkedIn's public job pages are limited until ${jobsCool.until}`);
      continue;
    }
    const cap = capReached(s.kind === 'jobs' ? 'job' : 'post');
    if (cap) {
      // said once per kind; the remaining searches of that kind are skipped right away
      if (!capTold[s.kind]) logger.info(`Prospects: today's limit of ${cap} new ${s.kind} is reached – the other ${s.kind} searches are skipped (Settings → Extra for today for more)`);
      capTold[s.kind] = true;
      if (capReached('job') && capReached('post')) break;
      continue;
    }
    let r;
    try {
      r = s.kind === 'jobs' ? await runJobs(s, ctx) : await runPosts(s, ctx);
    } catch (e) {
      if (e.name === 'StopSignal' || e.constructor.name === 'StopSignal') throw e;
      // public job pages limited: only the job searches wait, the post searches go on
      if (e instanceof safety.RateLimitError && e.publicOnly && s.kind === 'jobs') {
        const c = safety.startCooldown(e.hours || 1, e.message, 'jobs');
        logger.warn(`${e.message} – job searches wait until ${c.until}; post searches keep going (your account is fine)`);
        continue;
      }
      if (e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) throw e; // the runner stops and cools down
      logger.warn(`Prospects "${s.label}": failed – ${e.message}`);
      r = { read: 0, kept: 0, rejected: 0, dup: 0, error: e.message };
      if (!retry) queue.push({ s, retry: true });
    }
    const b = bySearch[s.id] || (bySearch[s.id] = { read: 0, kept: 0, rejected: 0, dup: 0, failed: 0, capped: false });
    for (const k of ['read', 'kept', 'rejected', 'dup']) b[k] += r[k] || 0;
    if (r.error) b.failed++;
    b.capped = b.capped || !!r.capped;
    const summary = `read ${b.read} · kept ${b.kept} · filtered out ${b.rejected} · already seen ${b.dup}${b.failed ? ` · ${b.failed} part(s) failed: ${r.error || ''}` : ''}${b.capped ? ' · daily limit reached' : ''}`;
    db.prepare("UPDATE prospect_searches SET last_run_at = datetime('now','localtime'), last_result = ? WHERE id = ?").run(summary, s.id);
    const one = r.error ? `failed: ${r.error}` : `read ${r.read} · kept ${r.kept} · filtered out ${r.rejected} · already seen ${r.dup}${r.capped ? ' · daily limit reached' : ''}`;
    logger[r.kept ? 'success' : 'info'](`Prospects "${s.label}": ${one}`);
    emit('prospects', { search_id: s.id });
    total.kept += r.kept;
    total.read += r.read;
    if (i < queue.length - 1) {
      const st = getSettings();
      await ctx.wait(randBetween(st.tab_wait_min, st.tab_wait_max), 'Pause before the next search');
    }
  }
  logger.success(`Prospect search finished: ${total.kept} new prospect(s) from ${total.read} results`);
  return total;
}

/**
 * Post search actions: in the extension's background worker when it has them (faster, nothing to
 * freeze), otherwise in the bot tab like before.
 */
let bgOk = true;
async function postAction(action, args, timeout = 60000) {
  if (bgOk) {
    try {
      const res = await bridge.call('bg', { action, args }, timeout);
      if (res && res.error) checkRateLimit(res.error, /^(postSearch|fetchJobMember)/.test(action));
      return res;
    } catch (e) {
      if (!/Unknown command|Unknown background action/.test(e.message)) { checkRateLimit(e.message, /^(postSearch|fetchJobMember)/.test(action)); throw e; }
      bgOk = false; // older extension – reload it for the faster way
    }
  }
  if (action === 'fetchPosts') {
    const out = [];
    for (const id of args[0]) out.push(await execWork('fetchPost', [id], 45000).catch((e) => ({ id, error: e.message })));
    return out;
  }
  return execWork(action, args, timeout);
}

/** Before a retry: wait (up to 3 min) for the extension, then make sure the bot tab is there again */
async function waitForBrowser(ctx) {
  for (let i = 0; i < 18 && !bridge.isConnected(); i++) await ctx.wait(10, 'Waiting for Chrome to answer again');
  if (!bgOk) await bridge.call('useWorkTab', { role: TABS.work }).catch((e) => logger.warn(`Bot tab not ready: ${e.message}`));
}

async function openSearch(s, ctx) {
  const st = getSettings();
  ctx.setStep(s, 'opening search');
  logger.info(`Prospects "${s.label || s.name}": searching ${s.kind === 'jobs' ? 'jobs' : 'posts'} for ${s.keywords}${s.location ? ` in ${s.location}` : ''}`);
  // Everything is read with fetch() from inside linkedin.com, so the bot tab only needs to be on a
  // linkedin.com page. A plain text page is used: Chrome freezes heavy pages in background tabs.
  // With a current extension the search runs in its background worker – no tab needed at all
  if (!bgOk) {
    try {
      await wakeWork();
    } catch (e) {
      if (!/tab was closed|No .*tab/i.test(e.message)) throw e;
      // the bot tab was closed (by you or after the last job) -> open it again in the background
      logger.info('Bot tab was closed – opening it again in the background');
      await bridge.call('useWorkTab', { role: TABS.work });
      await wakeWork();
    }
  }
  await ctx.wait(randBetween(st.tab_wait_min, st.tab_wait_max), `Reading "${s.label || s.name}" results`);
}

/** Opens a page in the bot's second tab, reads it with `action`, closes it. */
async function visit(url, action, why, ctx) {
  const st = getSettings();
  // wait first (looks like reading), then open the page and read it straight away: a background tab
  // that sits idle gets frozen by Chrome
  await ctx.wait(randBetween(st.prospect_profile_wait_min, st.prospect_profile_wait_max), why);
  await bridge.call('openTab', { url, settle: 2, role: TABS.job, near: TABS.work });
  safety.countProfileView();
  try {
    const seen = await bridge.call('exec', { tab: TABS.job, action: 'securityCheck' }, 30000).catch(() => '');
    if (seen) throw new safety.RestrictedError(`LinkedIn showed a security / restriction page: "${seen}"`);
    try {
      return (await bridge.call('exec', { tab: TABS.job, action }, 30000)) || {};
    } catch (e) {
      if (!/did not respond/i.test(e.message)) throw e;
      logger.info('The profile tab was asleep – reloading it');
      await bridge.call('navigate', { tab: TABS.job, url, settle: 2 }, 60000);
      return (await bridge.call('exec', { tab: TABS.job, action }, 30000)) || {};
    }
  } finally {
    await bridge.call('closeTab', { tab: TABS.job }).catch(() => {});
  }
}

// ---------------- posts ----------------
// LinkedIn subdomain of the author's profile link (in.linkedin.com = India) -> country, to skip early
const CC_COUNTRY = {
  in: 'india', pk: 'pakistan', bd: 'bangladesh', lk: 'sri lanka', np: 'nepal', ph: 'philippines', id: 'indonesia', my: 'malaysia',
  vn: 'vietnam', th: 'thailand', sg: 'singapore', cn: 'china', hk: 'hong kong', tw: 'taiwan', kr: 'south korea', jp: 'japan',
  ae: 'united arab emirates', sa: 'saudi arabia', qa: 'qatar', kw: 'kuwait', om: 'oman', bh: 'bahrain', jo: 'jordan', lb: 'lebanon', tr: 'turkey', il: 'israel',
  eg: 'egypt', ng: 'nigeria', ke: 'kenya', za: 'south africa', gh: 'ghana', ma: 'morocco', tn: 'tunisia', dz: 'algeria', et: 'ethiopia', ug: 'uganda', tz: 'tanzania',
  uk: 'united kingdom', ca: 'canada', au: 'australia', nz: 'new zealand', ie: 'ireland', de: 'germany', fr: 'france', es: 'spain', it: 'italy', nl: 'netherlands',
  be: 'belgium', ch: 'switzerland', at: 'austria', se: 'sweden', dk: 'denmark', no: 'norway', fi: 'finland', pl: 'poland', pt: 'portugal', cz: 'czech republic',
  ro: 'romania', gr: 'greece', hu: 'hungary', br: 'brazil', mx: 'mexico', ar: 'argentina', cl: 'chile', co: 'colombia', pe: 'peru',
};

async function runPosts(s, ctx) {
  await openSearch(s, ctx);
  ctx.setStep(s, 'loading posts');
  // Post ids come from the search page + LinkedIn's own "next page" request – no scrolling, so the
  // bot tab can stay in the background (it is never brought to the front).
  // one request per page, the waits between pages are done here (not in the background tab)
  const first = (await postAction('postSearchStart', [searchUrl(s), 10], 60000)) || {};
  const ids = [...(first.ids || [])];
  const jobOf = { ...(first.jobs || {}) }; // post id -> job attached to it
  const next = first.next;
  let pages = 0;
  let empty = 0;
  while (next && next.requestedArguments && ids.length < s.max_results && pages < 20) {
    pages++;
    await ctx.wait(randBetween(1.5, 3.5), 'Loading more posts');
    const page = (await postAction('postSearchPage', [next], 60000)) || {};
    const fresh = (page.ids || []).filter((id) => !ids.includes(id));
    ids.push(...fresh);
    Object.assign(jobOf, page.jobs || {});
    if (!fresh.length && ++empty >= 2) break; // no more results
    next.requestedArguments.payload.startIndex += 10; // what the page does when you scroll
  }
  ids.splice(s.max_results);
  const withJob = ids.filter((id) => jobOf[id]).length;
  logger.info(`Prospects "${s.label || s.name}": ${ids.length} posts found (${pages + 1} result pages)${withJob ? ` · ${withJob} with a job attached` : ''}`);
  const r = { read: ids.length, kept: 0, rejected: 0, dup: 0 };
  const settings = getSettings();
  const f = s.f || {};
  const postOpts = {
    extra: cvWords(settings), topics: words(f.topics), excludeWords: words(f.excludeWords), excludeHeadline: words(f.excludeHeadline),
    postType: f.postType || 'any', remoteHiring: f.remoteHiring !== false, rules: f.rules || {},
  };
  // countries picked in the search, else Settings → target
  const target = words(f.countries).length ? words(f.countries).join(', ') : settings.prospect_target;
  const remoteHiringOn = f.remoteHiring !== false;

  // read the new posts 4 at a time (public post pages), then judge them one by one
  const fresh = ids.filter((id) => !exists(`post:act:${id}`));
  r.dup += ids.length - fresh.length;
  const read = new Map();
  for (const id of fresh) {
    await ctx.checkpoint();
    if (capReached('post')) { r.capped = true; break; }
    const key = `post:act:${id}`;
    if (!read.has(id)) {
      ctx.setStep(s, 'reading posts');
      await ctx.wait(randBetween(2.5, 5), 'Reading posts');
      const batch = fresh.slice(fresh.indexOf(id), fresh.indexOf(id) + 2); // 2 at a time – public post pages are rate limited
      const got = await postAction('fetchPosts', [batch], 90000).catch((e) => {
        if (e instanceof safety.RateLimitError || e instanceof safety.RestrictedError) throw e;
        return batch.map((b) => ({ id: b, error: e.message }));
      });
      (got || []).forEach((g) => read.set(String(g.id), g));
    }
    const p = read.get(String(id)) || { error: 'not read' };
    if (p.error) checkRateLimit(p.error, false);
    if (p && /tab was closed|No work tab|not connected/i.test(p.error || '')) throw new Error(p.error); // retried at the end
    // Members-only post: LinkedIn sends its sign-up page instead (still status 200) – it never opens
    // without login, so remember it instead of fetching it again every run. Only when another post of
    // this search did open, so a page-wide block never marks good posts.
    if (p && r.readOk && /not readable \(200\)/.test(p.error || '')) {
      save({ search_id: s.id, kind: 'post', source_key: key, url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`, status: 'rejected', reject_reason: 'members-only post (not public)' });
      r.rejected++;
      continue;
    }
    if (!p || p.error) { logger.warn(`Prospects: could not read post ${id} – ${p ? p.error : 'no answer'}`); continue; }
    r.readOk = true;
    const base = {
      search_id: s.id, kind: 'post', source_key: key, url: p.url, text: p.text, posted: (p.posted_date || '').slice(0, 10),
      person_name: p.author_kind === 'person' ? p.author_name : '',
      person_url: p.author_kind === 'person' ? p.author_url : '',
      company_name: p.author_kind === 'company' ? p.author_name : '',
      company_url: p.author_kind === 'company' ? p.author_url : '',
    };
    const reject = (why, extra = {}) => { save({ ...base, ...extra, status: 'rejected', reject_reason: why }); r.rejected++; };

    if (!p.author_url || !p.author_name) { reject('no person or company could be identified'); continue; }
    if (ageDays('', p.posted_date) > MAX_AGE_DAYS) { reject(`older than a week (posted ${base.posted})`); continue; }
    const v = judgePost({ text: p.text, author: p.author_name, isCompany: p.author_kind === 'company' }, postOpts);
    base.score = v.score;
    base.reasons = v.reasons.join(', ');
    if (!v.keep) { reject(v.rejects.join('; ')); continue; }
    const named = mentionsBlocked(p.text, settings.prospect_blocked);
    if (named) { reject(`post mentions a blocked country (${named})`); continue; }
    const hinted = CC_COUNTRY[p.author_country_code];
    if (hinted) {
      const h = checkBlocked(hinted, settings.prospect_blocked);
      if (!h.ok) { reject(`${h.reason} (from their LinkedIn profile link)`); continue; }
      const tg = checkTarget(hinted, target);
      if (!tg.ok) { reject(`${tg.reason} (from their LinkedIn profile link)`); continue; }
    }
    const same = db.prepare("SELECT id FROM prospects WHERE rtrim(person_url, '/') = ? AND person_url != '' AND status != 'rejected' AND kind = 'post'").get(base.person_url)
      || (base.company_url && db.prepare("SELECT id FROM prospects WHERE rtrim(company_url, '/') = ? AND status != 'rejected' AND kind = 'post'").get(base.company_url));
    if (same) { reject('this person / company is already in your list'); continue; }
    // the same post shared by a person and their company page (or reposted) = one prospect
    const twin = db.prepare("SELECT id FROM prospects WHERE kind = 'post' AND status != 'rejected' AND substr(text, 1, 200) = ?").get(String(p.text || '').slice(0, 200));
    if (twin) { reject('same post as a prospect already in your list'); continue; }
    // A job attached to / linked in the post: open it (with your login) – closed or not remote = skip
    const jobId = jobOf[id] || p.job_id;
    if (jobId) {
      const job = await postAction('fetchJobMember', [jobId], 45000).catch((e) => {
        if (e instanceof safety.RateLimitError || e instanceof safety.RestrictedError) throw e;
        return { error: e.message };
      });
      // only trust it when the job's title is about the post (a search page also lists other jobs)
      const titleWords = String(job.title || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const aboutPost = titleWords.some((w) => String(p.text || '').toLowerCase().includes(w));
      if (job.error) logger.info(`Prospects: could not check the job in ${p.author_name}'s post – ${job.error}`);
      else if (aboutPost) {
        logger.info(`Prospects: job in ${p.author_name}'s post – "${job.title}" · ${job.state || '?'}${job.closed ? ' · closed' : ''} · remote ${job.remote || '?'} · ${job.location || '?'}`);
        if (job.closed || (job.state && job.state !== 'LISTED')) { reject(`the job in the post is closed ("${job.title}")`); continue; }
        if (job.remote === 'false' && remoteHiringOn) { reject(`the job in the post is not remote ("${job.title}", ${job.location || 'on-site'})`); continue; }
        Object.assign(base, { job_id: String(jobId), job_title: job.title, job_info: ['Open', job.remote === 'true' ? 'Remote' : '', job.location].filter(Boolean).join(' · ') });
      }
    }

    // Claude reads the post: a real client, or a seller / advice post the rules missed?
    if (settings.prospect_ai_check) {
      ctx.setStep(s, `Claude is reading ${p.author_name}'s post`);
      const ai = await judgeWithClaude(p);
      if (ai.error) logger.warn(`Prospects: Claude could not check ${p.author_name}'s post (${ai.error}) – kept on the rules alone`);
      else if (!ai.client) { reject(`Claude: ${ai.reason || 'not a client'}`); logger.info(`Prospect skipped by Claude – ${p.author_name}: ${ai.reason}`); continue; }
      else base.reasons = [base.reasons, `Claude: ${ai.reason}`].filter(Boolean).join(', ');
    }
    if (safety.profileViewsLeft() <= 0) {
      // not saved: the post is checked again on another day
      logger.info(`Prospects: today's limit of ${getSettings().prospect_daily_profile_views} profile visits is reached (Settings → Account safety) – the rest waits for tomorrow`);
      r.capped = true;
      break;
    }
    // Passed the text checks – now where the author is based and what they do (headline)
    ctx.setStep(s, `checking ${p.author_name}`);
    const isCompany = p.author_kind === 'company';
    const page = await visit(isCompany ? `${p.author_url}/about/` : p.author_url, isCompany ? 'readCompany' : 'readProfile', `Checking where ${p.author_name} is based`, ctx);
    const headline = page.headline || '';
    if (headline) {
      const hv = judgePost({ text: p.text, headline, author: p.author_name }, postOpts);
      if (!hv.keep) { reject(hv.rejects.join('; '), { headline, location: page.location || '' }); continue; }
    }
    let loc = checkBlocked(page.location, settings.prospect_blocked);
    if (loc.ok) loc = checkTarget(page.location, target);
    if (!loc.ok) { reject(loc.reason, { headline, location: page.location || '' }); logger.info(`Prospect skipped – ${p.author_name}: ${loc.reason}`); continue; }

    save({ ...base, headline, company_name: base.company_name || companyFromHeadline(headline), location: page.location, status: 'new' });
    r.kept++;
    logger.success(`New prospect: ${p.author_name} (${page.location}) – ${v.reasons.slice(0, 3).join(', ')}`);
    emit('prospects', { search_id: s.id });
  }
  return r;
}

// ---------------- jobs ----------------
/** Where a job is: its card location, else the search's location */
const loc0 = (j, s) => j.location || s.location || '';

async function runJobs(s, ctx) {
  await openSearch(s, ctx);
  ctx.setStep(s, 'loading jobs');
  // Same query as the search page, read from LinkedIn's job search results directly (no scrolling needed)
  const query = searchUrl(s).split('?')[1];
  const seen = new Map();
  for (let start = 0; start < s.max_results && start < 200; start += 10) {
    if (start) await ctx.wait(randBetween(3, 6), 'Loading more jobs');
    const page = (await postAction('fetchJobPage', [query, start], 60000)) || [];
    const fresh = page.filter((j) => !seen.has(j.job_id));
    fresh.forEach((j) => seen.set(j.job_id, j));
    if (!fresh.length) break;
  }
  const jobs = [...seen.values()].slice(0, s.max_results);
  const r = { read: jobs.length, kept: 0, rejected: 0, dup: 0 };
  const settings = getSettings();
  const f = s.f || {};

  for (const j of jobs) {
    await ctx.checkpoint();
    if (capReached('job')) { r.capped = true; break; }
    const key = `job:${j.job_id}`;
    if (exists(key)) { r.dup++; continue; }
    const url = `https://www.linkedin.com/jobs/view/${j.job_id}/`;
    const base = { search_id: s.id, kind: 'job', source_key: key, url, title: j.title, company_name: j.company, location: j.location, posted: j.posted };
    const reject = (why, extra = {}) => { save({ ...base, ...extra, status: 'rejected', reject_reason: why }); r.rejected++; };

    if (ageDays(j.posted, j.posted_date) > MAX_AGE_DAYS) { reject(`older than a week (posted ${j.posted || j.posted_date})`); continue; }
    const v = judgeJob(j, { extra: cvWords(settings), titles: words(f.titles), excludeWords: words(f.excludeWords), excludeCompanies: words(f.excludeCompanies), rules: f.rules || {} });
    base.score = v.score;
    base.reasons = v.reasons.join(', ');
    if (!v.keep) { reject(v.rejects.join('; ')); continue; }
    // LinkedIn already filtered the search by location; an unclear city ("Lead, SD") is fine then,
    // but a location that names a blocked country never is.
    // jobs: also never in Settings → "Never keep jobs in" (UK / US / Canada) – posts from there are fine
    const jobBlocked = [settings.prospect_blocked, settings.prospect_job_blocked].filter(Boolean).join(', ');
    let loc = checkBlocked(loc0(j, s), jobBlocked);
    // a search with its own locations already decides where; older searches use Settings → target
    if (!s.f && (loc.ok || (loc.unclear && s.location))) loc = checkTarget(loc.unclear ? s.location : j.location, settings.prospect_target);
    if (!loc.ok && !(loc.unclear && s.location)) { reject(loc.reason); continue; }
    if (db.prepare("SELECT id FROM prospects WHERE kind = 'job' AND status != 'rejected' AND lower(company_name) = lower(?)").get(j.company)) {
      reject('this company is already in your list');
      continue;
    }

    // Full posting: experience, worldwide / local-only, seniority
    ctx.setStep(s, `reading the ${j.company} job`);
    await ctx.wait(randBetween(settings.prospect_profile_wait_min, settings.prospect_profile_wait_max), `Reading the ${j.company} job`);
    const job = await postAction('fetchJob', [j.job_id], 45000).catch((e) => {
      if (e instanceof safety.RateLimitError || e instanceof safety.RestrictedError) throw e;
      return null;
    });
    if (!job) { reject('could not read the job posting'); continue; }
    const country = countryOf(job.location || j.location) || countryOf(s.location);
    const d = judgeJobDetail({ ...j, ...job, title: j.title, location: j.location }, {
      country,
      globalOnly: s.f ? [] : parseCountries(settings.prospect_global_only),
      globalAll: s.f ? (f.applyFrom ? f.applyFrom !== 'any' : !!f.worldwide) : globalAll(settings),
      allowEurope: !!(s.f && f.applyFrom === 'europe'),
      rules: f.rules || {},
      requireRemote: s.f ? words(f.workplace).length === 1 && f.workplace[0] === 'remote' : false,
      checkLanguages: s.f ? f.englishOnly !== false : true,
      maxYears: s.f && f.maxYears != null && f.maxYears !== '' ? Number(f.maxYears) : settings.prospect_max_experience,
      needDuties: !!v.titleUnclear,
      extra: cvWords(settings),
    });
    const extra = { company_url: job.company_url || '', text: job.description.slice(0, 1500) };
    if (!d.keep) { reject(d.rejects.join('; '), extra); continue; }

    save({
      ...base,
      ...extra,
      status: 'new',
      reasons: [...v.reasons, ...d.reasons].join(', '),
      person_name: job.person ? job.person.name : '',
      person_url: job.person ? job.person.url : '',
    });
    r.kept++;
    logger.success(`New prospect: ${j.company} is hiring "${j.title}"${job.person ? ` – posted by ${job.person.name}` : ''}${d.reasons.length ? ` (${d.reasons.join(', ')})` : ''}`);
    emit('prospects', { search_id: s.id });
  }
  return r;
}

module.exports = { TABS, runSearches, searchUrl };
