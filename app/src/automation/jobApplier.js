// Job applier (/jobs): finds remote Easy Apply jobs that fit your CV and applies with your LinkedIn resume.
//   1. jobs waiting from before (their questions were answered since) go first
//   2. new jobs: LinkedIn's public job search, every job title × region, remote + Easy Apply, last week
//   3. each job: right title, English, not too many years asked, Pakistan only with a good salary
//   4. Easy Apply in the bot's own tab, step by step with your saved answers. A question without an
//      answer -> the application is discarded and the question shows on the dashboard to answer once.
// It has its own status and tab ('apply'), and runs once a day by itself when Settings say so.
const { spawn } = require('child_process');
const { db, getSettings, getState, setState } = require('../db');
const { logger, emit } = require('../logger');
const bridge = require('./bridge');
const safety = require('./safety');
const notify = require('./notify');
const { assertSafe } = require('./linkedin');
const { otherLanguage, requiredYears } = require('../prospects/filter');
const { answerFromCv } = require('../jobs/aiAnswer');
const { topicOf, similar } = require('../jobs/topics');

const TAB = 'apply';
const state = { status: 'idle', test: false, current: null, wait: null, startedAt: null };
let stopRequested = false;
// stopped: you pressed Stop – nothing starts by itself until you press Apply now
const getStatus = () => ({ ...state, stopped: !!getState('jobs_stopped'), appliedToday: appliedToday(), target: getSettings().jobs_daily });
const publish = () => emit('jobs_status', getStatus());

class StopSignal extends Error {}
const rand = (a, b) => a + Math.random() * (b - a);
const today = () => new Date().toLocaleString('sv-SE').slice(0, 10);
const now = () => new Date().toLocaleString('sv-SE').replace('T', ' ');
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const appliedToday = () => db.prepare("SELECT COUNT(*) c FROM job_apps WHERE status = 'applied' AND applied_at >= ?").get(today()).c;

async function wait(seconds, reason) {
  const until = Date.now() + seconds * 1000;
  state.wait = { until, seconds: Math.round(seconds), reason };
  publish();
  while (Date.now() < until && !stopRequested) await new Promise((r) => setTimeout(r, 300));
  state.wait = null;
  publish();
  if (stopRequested) throw new StopSignal();
}
const step = (text, job) => { state.current = { step: text, job: job ? `${job.title} – ${job.company}` : '' }; publish(); };

// ---------- which jobs ----------
// a title fits only when it holds every word of one of YOUR keywords (Jobs page), in any order:
// "Email Marketing" -> "Email Marketing Specialist", "Marketing (Email) Executive"
const NOT_FOR_YOU = ['cold call', 'cold calling', 'caller', 'calling', 'dialer', 'telesales', 'telemarketing', 'call center', 'call centre',
  'sales', 'sdr', 'bdr', 'account executive', 'director', 'vice president', 'vp', 'head of', 'chief', 'cto', 'ceo', 'intern', 'internship',
  'engineer', 'developer', 'teacher', 'nurse', 'driver', 'accountant', 'designer'];
// word stems, so "Developer" matches "Development" and "Representatives" "Representative"
const stem = (w) => (w.length > 5 ? w.replace(/(ments?|ers?|ing|s)$/, '') : w);
const wordsOf = (t) => (String(t || '').toLowerCase().match(/[a-z0-9+#]+/g) || []).map(stem);
const hasPhrase = (t, p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t);

function titleFits(title, keywords) {
  const t = String(title || '').toLowerCase();
  // "Business Developer" is business development, not a software developer
  const tx = t.replace(/\bbusiness developers?\b/g, 'business development');
  const mine = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  // a word you search for yourself is never excluded ("Sales" as your keyword keeps sales jobs)
  if (NOT_FOR_YOU.some((w) => hasPhrase(tx, w) && !mine.some((k) => k.includes(w)))) return false;
  const tw = new Set(wordsOf(tx));
  return mine.some((k) => wordsOf(k).every((w) => tw.has(w)));
}

// phone work: cold calling, dialing, call centers
const CALLS = /\bcold[\s-]?call\w*|\bdial(ing|er|s)?\b|\bcalls? per (day|hour)\b|\bhigh volume of (outbound )?calls\b|\btele(sales|marketing)\b|\bcall cent(er|re)\b|\boutbound calls\b|\bphone prospecting\b/i;

// only for citizens / residents of a country ("Saudi National", "UAE nationals only", "must have the right to work in …")
const NATIONALITY = /\b(saudi|emirati|uae|qatari|kuwaiti|bahraini|omani|egyptian|jordanian|gcc|local)\s+(nationals?|citizens?|candidates only)\b|\bnationals? only\b|\bcitizens? only\b|\bsaudi[sz]ation\b|\bnationali[sz]ation\b|\bemiratisation\b|\bmust (be|hold) (a |an )?(\w+ )?(citizen|national|resident|citizenship|passport)\b|\b(right|authori[sz]ed|eligible) to work in\b|\bwork permit (is )?required\b|\bvalid (work )?(permit|visa|residency) (in|for)\b|\bmust (be )?(currently )?(based|located|living|reside) in\b/i;
const nationalityRule = (text) => { const m = String(text || '').match(NATIONALITY); return m ? m[0] : ''; };

/** Highest monthly pay named in a Pakistani job post, in PKR (0 = no salary shown) */
function monthlyPkr(text) {
  const t = String(text || '').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const NUM = '(\\d+(?:\\.\\d+)?)\\s*(k|lacs?|lakhs?)?';
  const CUR = '(pkr|rs\\.?|usd|\\$)';
  const re = new RegExp(`${CUR}\\s*${NUM}(?:\\s*(?:-|–|to)\\s*${CUR}?\\s*${NUM})?|${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s*(pkr|rs\\b|\\/-|usd|dollars)`, 'g');
  const value = (n, unit, cur, at) => {
    let v = Number(n);
    if (unit === 'k') v *= 1000;
    else if (unit && unit.startsWith('la')) v *= 100000;
    if (/usd|\$|dollar/.test(cur)) v *= 280;
    // yearly pay – not "2 years of experience", and not "200,000 monthly + annual bonus"
    const near = t.slice(at, at + 70);
    if (!/month|\/\s*mo\b/.test(near) && /\b(per|a)\s+(year|annum)\b|\/\s*(year|yr)\b|\byearly\b|\bannual(ly)?\b|\bp\.a\.?(\s|$)/.test(near)) v /= 12;
    return v >= 10000 && v < 20000000 ? v : 0;
  };
  let best = 0;
  let m;
  while ((m = re.exec(t))) {
    const cur = m[1] || m[11] || '';
    best = Math.max(best, value(m[2], m[3], cur, m.index), m[5] ? value(m[5], m[6] || m[3], cur, m.index) : 0,
      m[7] ? value(m[7], m[8] || m[10], cur, m.index) : 0, m[9] ? value(m[9], m[10], cur, m.index) : 0);
  }
  // no currency, but said to be the pay: "Salary: 180,000", "Salary range 1.5 lacs to 2 lacs"
  const said = new RegExp(`\\b(?:salary|compensation|remuneration|pay|package|stipend|ctc|take[- ]home)\\b[^\\d.]{0,40}?${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?`, 'g');
  while ((m = said.exec(t))) best = Math.max(best, value(m[1], m[2] || m[4], '', m.index), m[3] ? value(m[3], m[4] || m[2], '', m.index) : 0);
  return Math.round(best);
}

const SEARCH_TAB = 'jsearch';
/** One page of the logged-in job search -> [{ job_id, title, company, location }]. After 3 failures in a row the
 *  run goes back to the public search. */
async function loggedInPage(keyword, region, start, search) {
  const url = `https://www.linkedin.com/jobs/search/?${searchQuery(keyword, region)}${start ? `&start=${start}` : ''}`;
  try {
    // a fresh tab for every search: Chrome freezes a hidden tab that sat for a while (then nothing answers)
    if (search.tabOpen) await bridge.call('closeTab', { tab: SEARCH_TAB }).catch(() => {});
    await bridge.call('openTab', { url, settle: 5, role: SEARCH_TAB, near: TAB });
    search.tabOpen = true;
    await assertSafe(SEARCH_TAB);
    const r = await bridge.call('exec', { tab: SEARCH_TAB, action: 'jobSearchPage', args: [] }, 90000);
    if (!r || !Array.isArray(r.jobs)) throw new Error('the search page did not answer');
    search.fails = 0;
    return r.jobs.filter((j) => !j.applied);
  } catch (e) {
    if (e instanceof safety.RestrictedError) throw e;
    search.fails = (search.fails || 0) + 1;
    search.errors = (search.errors || 0) + 1;
    logger.warn(`Logged-in job search "${keyword}" in ${region} failed: ${e.message}`);
    if (search.fails >= 6) { search.loggedIn = false; logger.warn('Job search: going back to LinkedIn\'s public search for this run'); }
    return [];
  }
}

function searchQuery(keyword, region) {
  // posted in the last 30 days (a week left too few remote Easy Apply jobs)
  const q = new URLSearchParams({ keywords: keyword, location: region, f_TPR: 'r2592000', f_WT: '2', f_AL: 'true', sortBy: 'DD' });
  if (/^worldwide$/i.test(region)) q.set('geoId', '92000000');
  return q.toString();
}

async function bg(action, args, timeout = 60000) {
  const res = await bridge.call('bg', { action, args }, timeout);
  if (res && res.error) throw new Error(res.error);
  return res;
}

const saveJob = db.prepare(`INSERT INTO job_apps (job_id, title, company, location, region, keyword, url, status, reason)
  VALUES (@job_id, @title, @company, @location, @region, @keyword, @url, @status, @reason)
  ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = datetime('now','localtime')`);
const known = db.prepare('SELECT 1 FROM job_apps WHERE job_id = ?');

// countries / areas named in a title or location that are not your regions ("Founding UK …", "ANZ (Sydney/Melbourne)")
const PLACES = { 'united states': /\b(united states|usa|u\.s\.|us-based|us based)\b/i, 'United Kingdom': /\b(united kingdom|uk|england|london)\b/i, Canada: /\bcanada\b/i,
  Australia: /\b(australia|anz|sydney|melbourne)\b/i, 'New Zealand': /\bnew zealand\b/i, India: /\bindia\b/i, Germany: /\b(germany|deutschland)\b/i, France: /\bfrance\b/i };
function outsideRegions(j, regions) {
  const mine = regions.map((r) => r.toLowerCase()).filter((r) => r !== 'worldwide');
  // "Dublin, County Dublin, Ireland (Remote)" -> the place only
  const loc = String(j.location || '').toLowerCase().replace(/\((remote|on-site|hybrid)\)/g, '').trim();
  for (const [name, re] of Object.entries(PLACES)) if (re.test(j.title) && !mine.includes(name.toLowerCase())) return name;
  if (!loc || /remote|worldwide|anywhere|emea|europe|european union|middle east|gcc|mena|global/.test(loc)) return '';
  // the location must name one of your regions ("Dubai, United Arab Emirates", "Cyprus") – "Dallas-Fort Worth Metroplex" does not
  return mine.some((r) => loc.includes(r)) ? '' : loc.split(',').pop().trim();
}

/** Every keyword × region of this run, in random order so each day starts somewhere else */
function newSearch(s) {
  const keywords = list(s.jobs_keywords);
  const regions = list(s.jobs_regions);
  if (s.jobs_pakistan && !regions.some((r) => /^pakistan$/i.test(r))) regions.push('Pakistan');
  if (!keywords.length || !regions.length) throw new Error('Set keywords and regions on the Applications page first');
  return { loggedIn: true, keywords, regions, pairs: keywords.flatMap((k) => regions.map((r) => [k, r])).sort(() => Math.random() - 0.5), reads: 0 };
}

/** The search of the run in progress. Saving new keywords / regions switches it right away. */
let activeSearch = null;
function updateSearch(s) {
  if (!activeSearch) return;
  const { keywords, regions, pairs } = newSearch(s);
  Object.assign(activeSearch, { keywords, regions, pairs });
  logger.info(`Job search changed – now ${keywords.length} keyword(s) in ${regions.join(', ')}`);
}

/** Searches the next keyword × region pages until at least `need` new jobs passed every check (saved as
 *  'queued'), so applying starts right away instead of after the whole search */
async function findJobs(need, s, search) {
  const found = [];
  while (search.pairs.length && found.length < need && search.reads < 200) {
    const [keyword, region, start = 0] = search.pairs.shift();
    step(`Searching "${keyword}" in ${region}${start ? ` (page ${start / 10 + 1})` : ''}`);
    if (search.reads++) await wait(rand(3, 6), 'Next job search');
    let page = [];
    try {
      if (search.loggedIn) {
        // your own (logged-in) job search: its Remote + Easy Apply filters really work
        page = await loggedInPage(keyword, region, start, search);
        if (page.length >= 25 && start < 50) search.pairs.push([keyword, region, start + 25]);
      } else {
        page = (await bg('fetchJobPage', [searchQuery(keyword, region), start])) || [];
        // a full page: its next page comes later in this run (up to page 4)
        if (page.length >= 10 && start < 30) search.pairs.push([keyword, region, start + 10]);
      }
    } catch (e) {
      if (/\b(429|999)\b/.test(e.message)) { logger.warn(`Job search: LinkedIn is limiting its public job pages – going on with ${found.length} job(s) found`); search.pairs = []; break; }
      search.errors = (search.errors || 0) + 1;
      logger.warn(`Job search "${keyword}" in ${region} failed: ${e.message}`);
      continue;
    }
    for (const j of page) {
      if (known.get(j.job_id)) continue;
      const row = { job_id: j.job_id, title: j.title, company: j.company, location: j.location, region, keyword, url: `https://www.linkedin.com/jobs/view/${j.job_id}/`, status: 'skipped', reason: '' };
      if (!titleFits(j.title, search.keywords)) { saveJob.run({ ...row, reason: 'title does not fit your skills' }); continue; }
      // LinkedIn's public search ignores the remote filter: remote jobs show a country / region ("Ireland",
      // "European Union"), office jobs a city ("Dublin, County Dublin, Ireland") – skip those unless the title says remote
      if (String(j.location || '').includes(',') && !/\bremote\b|work from home|\bwfh\b/i.test(`${j.title} ${j.location}`)) { saveJob.run({ ...row, reason: `in ${j.location} – a city job, most likely on-site` }); continue; }
      if (j.company && db.prepare("SELECT 1 FROM job_apps WHERE status IN ('applied', 'queued', 'needs_answers') AND lower(company) = lower(?) AND COALESCE(applied_at, updated_at) >= datetime('now','localtime','-30 days')").get(j.company)) {
        saveJob.run({ ...row, reason: `already applied to ${j.company} (or it is waiting)` });
        continue;
      }
      const away = outsideRegions(j, search.regions);
      if (away) { saveJob.run({ ...row, reason: `based in ${away} – not one of your regions` }); continue; }
      if (nationalityRule(j.title)) { saveJob.run({ ...row, reason: `only for locals ("${nationalityRule(j.title)}")` }); continue; }
      const lang = otherLanguage(j.title, '');
      if (lang) { saveJob.run({ ...row, reason: `asks for ${lang}` }); continue; }
      // the full post: language, years asked, salary (Pakistan)
      await wait(rand(4, 8), `Reading the ${j.company} job`);
      let d = null;
      try { d = await bg('fetchJob', [j.job_id], 45000); } catch (e) {
        if (/\b(429|999)\b/.test(e.message)) { logger.warn('Job search: LinkedIn is limiting its public job pages – stopping the search for now'); search.pairs = []; return found; }
      }
      if (!d) { saveJob.run({ ...row, reason: 'could not read the job post' }); continue; }
      const lang2 = otherLanguage(j.title, d.description);
      if (lang2) { saveJob.run({ ...row, reason: `asks for ${lang2}` }); continue; }
      const calls = (d.description.match(CALLS) || [])[0];
      if (calls) { saveJob.run({ ...row, reason: `a calling job ("${calls}")` }); continue; }
      const nat = nationalityRule(d.description);
      if (nat && region !== 'Pakistan' && !/pakistan/i.test(j.location || '')) { saveJob.run({ ...row, reason: `only for locals ("${nat}")` }); continue; }
      const yrs = requiredYears(d.description);
      if (yrs != null && yrs > s.jobs_max_years) { saveJob.run({ ...row, reason: `asks for ${yrs}+ years` }); continue; }
      if (region === 'Pakistan' || /pakistan/i.test(j.location || '')) {
        const pay = monthlyPkr(d.description);
        if (!pay) { saveJob.run({ ...row, reason: 'Pakistan job without a salary shown' }); continue; }
        if (pay < s.jobs_pk_min_salary) { saveJob.run({ ...row, reason: `pays about PKR ${pay.toLocaleString('en')} a month (below your minimum)` }); continue; }
      }
      saveJob.run({ ...row, status: 'queued', reason: '' });
      found.push(row);
    }
  }
  return found;
}

// ---------- answers ----------
/** Your expected monthly salary for this job: PKR for a job in Pakistan, USD for every other */
function salaryFor(job, s) {
  const pk = job.region === 'Pakistan' || /pakistan/i.test(job.location || '');
  const n = pk ? s.jobs_salary_pk : s.jobs_salary_usd;
  return { number: String(n), text: `${Number(n).toLocaleString('en')} ${pk ? 'PKR' : 'USD'} per month`, currency: pk ? 'PKR' : 'USD' };
}
const savedAnswers = () => db.prepare("SELECT label, answer FROM job_answers WHERE answer != '' ORDER BY updated_at DESC").all();
const answersMap = () => Object.fromEntries(db.prepare("SELECT key, answer FROM job_answers WHERE answer != ''").all().map((r) => [r.key, r.answer]));

function rememberQuestions(questions) {
  const up = db.prepare(`INSERT INTO job_answers (key, label, kind, options) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, kind = excluded.kind, options = excluded.options, seen = seen + 1`);
  for (const q of questions) if (q.key) up.run(q.key, q.label, q.kind || '', JSON.stringify(q.options || []));
}

/** After you answer a question: jobs that only waited for answers you have now go back in the queue */
function requeueAnswered() {
  // an answer also fills the same question asked in other words
  const byTopic = {};
  for (const r of savedAnswers()) { const t = topicOf(r.label); if (t && !(t in byTopic)) byTopic[t] = r.answer; }
  const fill = db.prepare("UPDATE job_answers SET answer = ?, updated_at = datetime('now','localtime') WHERE key = ?");
  const saved = savedAnswers();
  for (const q of db.prepare("SELECT key, label, options FROM job_answers WHERE answer = ''").all()) {
    const t = topicOf(q.label);
    if (t && byTopic[t]) { fill.run(byTopic[t], q.key); continue; }
    // or nearly the same question you answered before
    const near = saved.find((x) => similar(x.label, q.label));
    if (near) fill.run(near.answer, q.key);
  }
  const have = answersMap();
  let n = 0;
  for (const j of db.prepare("SELECT id, questions FROM job_apps WHERE status = 'needs_answers'").all()) {
    let qs = [];
    try { qs = JSON.parse(j.questions || '[]'); } catch { /* none */ }
    // a question whose saved answer LinkedIn refused waits for a changed answer
    if (qs.every((q) => have[q.key] && have[q.key] !== q.tried)) {
      db.prepare("UPDATE job_apps SET status = 'queued', reason = 'answers added – applying again', updated_at = datetime('now','localtime') WHERE id = ?").run(j.id);
      n++;
    }
  }
  return n;
}

// ---------- applying ----------
let tabOpen = false;
async function openJob(url, s) {
  const settle = s.page_load_wait;
  // a fresh tab for every job: a half-filled form on the old page can't block going to the next one
  if (tabOpen) await bridge.call('closeTab', { tab: TAB }).catch(() => {});
  await bridge.call('openTab', { url, settle, role: TAB, near: TAB });
  tabOpen = true;
  await assertSafe(TAB);
}

async function applyOne(job, s, test, retry = false) {
  // one application per company in 30 days
  if (!retry && !test && db.prepare("SELECT 1 FROM job_apps WHERE status = 'applied' AND lower(company) = lower(?) AND job_id != ? AND applied_at >= datetime('now','localtime','-30 days')").get(job.company, job.job_id)) {
    db.prepare("UPDATE job_apps SET status = 'skipped', reason = ?, updated_at = datetime('now','localtime') WHERE job_id = ?").run(`already applied to ${job.company}`, job.job_id);
    logger.info(`Not applied: ${job.title} – ${job.company} – already applied to this company`);
    return 'skipped';
  }
  step('Opening the job', job);
  await openJob(job.url, s);
  step(test ? 'Filling the form (test – no Submit)' : 'Applying with Easy Apply', job);
  let r;
  try {
    r = (await bridge.call('exec', { tab: TAB, action: 'easyApply', args: [{ answers: answersMap(), saved: savedAnswers(), years: s.jobs_years, salary: salaryFor(job, s), submit: !test, title: job.title }] }, 240000)) || { status: 'failed', reason: 'the page did not answer' };
  } catch (e) {
    if (!/did not respond/i.test(e.message)) throw e;
    // Chrome froze the hidden tab in the middle of the form: try this job once more on a later run
    const before = db.prepare('SELECT reason FROM job_apps WHERE job_id = ?').get(job.job_id);
    const again = !(before && /^the page stopped responding/.test(before.reason));
    r = { status: again ? 'queued' : 'failed', reason: `the page stopped responding${again ? ' – tried again later' : ' twice'}` };
  }
  if ((r.status === 'retry' && /submit/i.test(r.reason || '')) || (r.status === 'failed' && /no confirmation after submit/i.test(r.reason || ''))) {
    // the form went blank after Submit: reload the job – LinkedIn shows "Applied" when it went out
    await openJob(job.url, s).catch(() => {}); // a fresh tab – the half-open form can't block it
    const st = await bridge.call('exec', { tab: TAB, action: 'jobState', args: [] }, 60000).catch(() => 'unknown');
    if (st === 'already') r = { ...r, status: 'applied', reason: 'confirmed by reloading the job page' };
  }
  if (r.status === 'already') {
    // "Applied" on a job whose Submit we pressed before (it had gone blank) = it did go out
    const before = db.prepare('SELECT reason FROM job_apps WHERE job_id = ?').get(job.job_id);
    if (before && /submit/i.test(before.reason)) r = { ...r, status: 'applied', reason: 'confirmed – LinkedIn shows it as applied' };
  }
  if (r.status === 'retry') {
    // LinkedIn left the form empty: once more on a later run
    const before = db.prepare('SELECT reason FROM job_apps WHERE job_id = ?').get(job.job_id);
    const what = r.reason || 'the form stayed empty';
    const again = !(before && before.reason.startsWith(what));
    r = { ...r, status: again ? 'queued' : 'failed', reason: `${what}${again ? ' – tried again later' : ' twice'}` };
  }
  const resume = r.resume ? r.resume.chosen : '';
  const fields = {
    status: ['external', 'closed', 'already', 'language', 'unfit'].includes(r.status) ? 'skipped' : r.status === 'limit' ? 'queued' : r.status,
    reason: r.reason || '',
    resume,
    questions: r.questions ? JSON.stringify(r.questions) : '',
    trace: r.trace ? JSON.stringify({ resumes: r.resume ? r.resume.all : [], steps: r.trace }) : '',
  };
  if (r.status === 'needs_answers') {
    rememberQuestions(r.questions || []);
    // what your CV answers: Claude writes a short answer, saved for every later form too, and the job is tried again
    const qs = (r.questions || []).filter((q) => q.key);
    if (!retry && qs.length) {
      step(`Answering ${qs.length} question(s) from your CV`, job);
      const known = Object.fromEntries(db.prepare("SELECT label, answer FROM job_answers WHERE answer != '' ORDER BY seen DESC LIMIT 25").all().map((x) => [x.label, x.answer]));
      const got = await answerFromCv(qs.map((q) => ({ ...q, options: q.options || [] })), job, known);
      if (got.error) logger.warn(`Could not answer from your CV: ${got.error}`);
      const keys = Object.keys(got).filter((k) => k !== 'error');
      const save = db.prepare("UPDATE job_answers SET answer = ?, source = 'cv', updated_at = datetime('now','localtime') WHERE key = ?");
      for (const k of keys) save.run(got[k], k);
      if (!keys.length && !got.error) logger.info(`Your CV doesn't answer: ${qs.map((q) => `"${q.label.slice(0, 60)}"`).join(', ')}`);
      if (keys.length) logger.info(`Answered from your CV: ${keys.map((k) => `"${qs.find((q) => q.key === k).label.slice(0, 60)}" → ${got[k]}`).join(' · ')}`);
      if (qs.every((q) => got[q.key] && got[q.key] !== q.tried)) {
        await wait(rand(8, 15), 'Applying again with the answers from your CV');
        return applyOne(job, getSettings(), test, true);
      }
    }
  }
  db.prepare(`UPDATE job_apps SET status = @status, reason = @reason, resume = @resume, questions = @questions, trace = @trace,
    applied_at = CASE WHEN @status = 'applied' AND applied_at IS NULL THEN @at ELSE applied_at END, updated_at = datetime('now','localtime') WHERE job_id = @job_id`)
    .run({ ...fields, at: now(), job_id: job.job_id });
  const label = `${job.title} – ${job.company}`;
  if (r.status === 'applied') logger.info(`Applied: ${label}${resume ? ` (resume: ${resume})` : ''}`);
  else if (r.status === 'tested') logger.info(`Test: ${label} – the form filled up to Submit${resume ? ` (resume: ${resume})` : ''}, not sent`);
  else if (r.status === 'needs_answers') logger.warn(`Needs your answers: ${label} – ${(r.questions || []).map((q) => `"${q.label}"`).join(', ')}`);
  else logger.info(`Not applied: ${label} – ${r.reason || r.status}`);
  return r.status;
}

/**
 * Starts applying. test = fill the forms of up to 3 jobs but never press Submit.
 */
function start({ test = false, reason = '', manual = false } = {}) {
  if (state.status !== 'idle') throw new Error('The job applier is already running');
  const cool = safety.cooldown();
  if (cool) throw new Error(`Paused for account safety until ${cool.until}: ${cool.reason}`);
  if (!bridge.isConnected()) throw new Error('Chrome extension not connected. Open Chrome and make sure the "LinkedIn Bot" extension is enabled.');
  const s = getSettings();
  const target = test ? 3 : Math.max(0, s.jobs_daily - appliedToday());
  if (!target) throw new Error(`Today's ${s.jobs_daily} applications are done – more tomorrow`);
  if (manual && !test) setState('jobs_stopped', false);
  stopRequested = false;
  tabOpen = false;
  Object.assign(state, { status: 'running', test, current: null, wait: null, startedAt: new Date().toISOString() });
  publish();
  let awake = null;
  try { awake = spawn('caffeinate', ['-i'], { stdio: 'ignore' }); awake.on('error', () => {}); } catch { awake = null; }
  logger.info(`${test ? 'Job applier test (fills forms, never presses Submit)' : `Applying to jobs – ${target} to go today`}${reason ? ` · ${reason}` : ''}`);
  (async () => {
    const tally = { applied: 0, tested: 0, needs_answers: 0, other: 0 };
    try {
      let done = 0;
      const progress = () => (test ? tally.tested : tally.applied);
      // jobs waiting from before first, then new ones
      let queue = db.prepare("SELECT * FROM job_apps WHERE status IN ('queued', 'tested') ORDER BY status = 'queued' DESC, updated_at DESC LIMIT 50").all();
      const search = newSearch(getSettings());
      activeSearch = search;
      const tried = new Set();
      while (progress() < target && !stopRequested) {
        if (!queue.length) {
          // jobs that went back in the queue during this run (you answered their questions) come first
          queue = db.prepare("SELECT * FROM job_apps WHERE status = 'queued' ORDER BY updated_at DESC").all().filter((j) => !tried.has(j.job_id));
          if (queue.length) continue;
          if (!search.pairs.length || search.reads >= 200) {
            if ((search.errors || 0) >= 3) {
              logger.warn(`Job search had ${search.errors} network errors – trying again as soon as the connection works`);
              setState('last_auto_jobs_at', Date.now() - 2 * 3600000);
            } else logger.info('No more matching Easy Apply jobs right now');
            break;
          }
          queue = await findJobs(1, getSettings(), search);
          continue;
        }
        const job = queue.shift();
        tried.add(job.job_id);
        // found for another saved search: it stays waiting until that search is selected again
        if (!titleFits(job.title, search.keywords) || outsideRegions(job, search.regions)) continue;
        if (done++) { const w = getSettings(); await wait(rand(w.jobs_wait_min, w.jobs_wait_max), 'Next application'); }
        const st = await applyOne(job, getSettings(), test);
        tally[st in tally ? st : 'other']++;
        if (st === 'limit') { logger.warn('LinkedIn says the Easy Apply limit for today is reached – applying again tomorrow'); break; }
      }
    } catch (e) {
      if (e instanceof StopSignal) logger.warn('Job applier stopped');
      else if (e instanceof safety.RestrictedError || e instanceof safety.RateLimitError) {
        const c = safety.startCooldown(e.hours || getSettings().safety_cooldown_hours, e.message);
        logger.error(`${e.message} – the bot pauses everything until ${c.until} to protect your account`);
      } else {
        logger.error(`Job applier failed: ${e.message}`);
        // lost internet / Chrome: the daily applying tries again in 10 minutes
        if (require('./runner').CONNECTION_ERROR.test(e.message)) {
          setState('last_auto_jobs_at', Date.now() - 2 * 3600000);
          logger.warn('Connection lost – applying starts again by itself as soon as the internet and Chrome are back');
        }
      }
    } finally {
      activeSearch = null;
      if (awake) awake.kill();
      if (bridge.isConnected()) await bridge.call('closeTabs', { roles: [TAB, SEARCH_TAB] }).catch(() => {});
      const waiting = db.prepare("SELECT COUNT(*) c FROM job_answers WHERE answer = ''").get().c;
      const title = test ? `Job test: ${tally.tested} form(s) filled up to Submit` : `Applied to ${appliedToday()} job(s) today`;
      const extra = `${tally.needs_answers ? ` · ${tally.needs_answers} need your answers` : ''}${waiting ? ` · ${waiting} question(s) to answer on /jobs` : ''}`;
      logger.info(`${title}${extra}`);
      notify.macNotification('LinkedIn Bot – Jobs', `${title}${extra}`);
      if (!test) notify.telegram(`💼 ${title}${extra}`).catch(() => {});
      Object.assign(state, { status: 'idle', test: false, current: null, wait: null });
      publish();
    }
  })();
  return getStatus();
}

function stop() {
  setState('jobs_stopped', true);
  if (state.status !== 'idle') {
    stopRequested = true;
    state.status = 'stopping';
  }
  publish();
  return getStatus();
}

/** Settings → "Apply by itself every day": with a start time once a day from then; without one any time
 *  the bot is free, until today's applications are done (a run that ran out of jobs waits 2 hours) */
function startSchedule(othersBusy) {
  setInterval(async () => {
    const s = getSettings();
    if (!s.jobs_auto || getState('jobs_stopped') || state.status !== 'idle' || !bridge.isConnected() || othersBusy() || safety.cooldown()) return;
    if (appliedToday() >= s.jobs_daily) return;
    const m = String(s.jobs_run_at || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    const d = new Date();
    if (m) {
      if (getState('last_auto_jobs') === today() || d.getHours() * 60 + d.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return;
    } else {
      const last = getState('last_auto_jobs_at');
      if (last && Date.now() - last < 2 * 3600000) return;
    }
    if (!(await require('./runner').online())) return; // no internet yet: checked again next minute
    setState('last_auto_jobs', today());
    setState('last_auto_jobs_at', Date.now());
    try { start({ reason: m ? `daily run (set for ${s.jobs_run_at})` : 'by itself – today\'s applications are not done yet' }); } catch (e) { logger.warn(`Job applications could not start: ${e.message}`); }
  }, 60000);
}

const isBusy = () => state.status !== 'idle';

module.exports = { start, stop, getStatus, startSchedule, isBusy, requeueAnswered, monthlyPkr, titleFits, nationalityRule, outsideRegions, updateSearch };
