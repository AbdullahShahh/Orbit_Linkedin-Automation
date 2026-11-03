// Decides whether a LinkedIn post or job is a real buyer for lead generation / outbound / email
// marketing services. Rule based and explainable: every decision comes with the reasons, so the
// "Filtered out" tab on the dashboard shows exactly why something was dropped.
//
// A post is kept only when ALL of these hold:
//   1. it states a need in its own words (looking for / need help / recommend / struggling / hiring …)
//   2. the need is about our topics (lead gen, outbound, cold email, email marketing, appointment setting …)
//   3. it is written from the buyer's side (I / we / our), not as advice or a sales pitch
//   4. no seller, job-seeker, course / training or engagement-bait signals
//   5. the author's headline doesn't show they sell these services themselves (competitor)

const norm = (s) => String(s || '')
  .normalize('NFKD').replace(/\p{M}/gu, '') // 𝙇𝙤𝙤𝙠𝙞𝙣𝙜 / accented letters -> plain
  .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim();

const TOPIC = [
  [/\blead[\s-]?gen(eration)?\b/i, 'lead generation'],
  [/\b(b2b )?leads\b/i, 'leads'],
  [/\boutbound\b/i, 'outbound'],
  [/\b(cold |bulk |mass |linkedin |email )?outreach\b/i, 'outreach'],
  [/\bcold[\s-](e-?mail(ing)?|call(ing|er|s)?|outreach|dm)\b/i, 'cold email / calling'],
  [/\be-?mail (marketing|campaigns?|sequences?|automation|list)\b/i, 'email marketing'],
  [/\b(bulk|mass) e-?mail(s|ing)?\b/i, 'bulk email'],
  [/\b(newsletter|deliverability|inbox placement)\b/i, 'email deliverability'],
  [/\bappointment[\s-]?(sett(ing|er|ers)|booking)\b/i, 'appointment setting'],
  [/\b(book(ed|ing)?|more|qualified|sales) (meetings|calls|appointments|demos)\b/i, 'booked meetings'],
  [/\b(sdrs?|bdrs?|sales development|business development)\b/i, 'business development'],
  [/\bprospect(ing|s)?\b/i, 'prospecting'],
  [/\bsales pipeline\b|\bpipeline\b.{0,40}\b(sales|leads|clients|customers|deals|prospects|meetings|revenue)\b|\b(sales|leads|clients|customers|deals|prospects|meetings|revenue)\b.{0,40}\bpipeline\b/i, 'pipeline'],
  [/\b(new |more |getting |get |find(ing)? |win(ning)? )(clients|customers)\b/i, 'getting clients'],
];

const NEED = [
  [/\b(looking for|in search of|searching for|seeking|on the hunt for)\b.{0,70}\b(agenc(y|ies)|freelancers?|consultants?|experts?|specialists?|partners?|someone|somebody|help|vendors?|services?|compan(y|ies)|firm|person|team|recommendations?|setters?|sdrs?|bdrs?|reps?)\b/i, 'looking for help'],
  [/\b(we|i|we'?re|i'?m|our (team|company|business|agency|startup)|my (team|company|business))\b[^.?!\n]{0,25}\b(need|needs|needed|require|requires|could use)\b.{0,40}\b(help|someone|somebody|an? (agency|freelancer|expert|consultant|specialist|partner|setter|sdr|bdr)|more (leads|clients|customers|meetings|appointments|sales|calls))\b/i, 'needs help'],
  [/\b(any|can (anyone|you|someone)|could (anyone|you|someone)|please|would love)\b.{0,30}\b(recommend|suggest|refer|recommendations?|suggestions?)\b/i, 'asks for recommendations'],
  [/\brecommendations? (for|on)\b/i, 'asks for recommendations'],
  [/\b(who|anyone|does anyone|do you guys) (can|could|knows?|has|have|use|uses|recommends?)\b.{0,50}\b(help|recommend|good|reliable|agency|tool|freelancer|someone)\b/i, 'asks who can help'],
  [/\b(do you|does anyone|anyone|you guys) know\b.{0,40}\b(agenc(y|ies)|freelancers?|consultants?|someone|somebody|compan(y|ies)|firm|experts?|tools?)\b/i, 'asks who can help'],
  [/\b(we|i|we'?re|i'?m|we'?ve|i'?ve|our (team|company|business|agency)|my (team|company|business))\b[^.?!\n]{0,20}\bstruggl\w*\b.{0,40}\b(to|with)\b/i, 'struggling'],
  [/\b(we|i)\b[^.?!\n]{0,10}\b(can'?t|cannot|are unable to|am unable to|haven'?t been able to|keep failing to|find it hard to)\b.{0,15}\b(get|find|generate|book|land|close|reach|scale)\b/i, "can't get results"],
  [/\b(we|i|we'?re|i'?m|we'?ve|i'?ve|our|my)\b[^.?!\n]{0,30}\b(no|not enough|zero|very few|barely any|low)\b.{0,12}\b(leads|clients|customers|replies|responses|meetings|bookings|sales|reply rates?|open rates?)\b/i, 'not enough leads / replies'],
  [/\b(our|my)\s+(sales\s+)?pipeline\b.{0,20}\b(dry|empty|thin|slow)\b/i, 'dry pipeline'],
  [/\b(emails?|campaigns?|messages)\b.{0,20}\b(go(ing)?|land(ing)?|end(ing)? up)\b.{0,10}\b(spam|junk|promotions)\b/i, 'emails going to spam'],
  [/\b(we'?re|we are|i'?m|i am|company is|team is|we'?ve been|currently)\b.{0,10}\b(hiring|looking to hire|recruiting)\b/i, 'is hiring'],
  [/\bhiring\b.{0,40}\b(sdrs?|bdrs?|appointment setters?|lead gen\w*|outbound|cold call\w*|email market\w*|business development|outreach)\b/i, 'is hiring for this'],
  [/\b(want(ing)?|plan(ning)?|thinking|looking) to outsource\b/i, 'wants to outsource'],
  [/\boutsourc\w*\b.{0,30}\b(lead|outbound|outreach|e-?mail|sales|appointment|prospecting)\b/i, 'wants to outsource'],
  [/\b(open to|accepting) (proposals|offers|pitches|bids)\b/i, 'open to proposals'],
];

// Seller / competitor / advice / engagement bait -> reject
const SELLER = [
  [/\b(i|we) help\b/i, 'sells services ("we help …")'],
  [/\b(i|we) (generated|booked|helped|delivered|closed|scaled)\b/i, 'brags about results for clients'],
  [/\b(dm|message|inbox|ping) (me|us)\b/i, 'asks readers to DM them'],
  [/\blooking for [^.?!\n]{0,60}\bservices?\b[^.?!\n]{0,40}\?|\b(we'?re|we are|i'?m|i am) here to help\b/i, 'sales hook question to the reader'],
  [/\b(you just need to|just|simply) (call|contact|book) (me|us)\b|\bcall me\b/i, 'asks readers to call them (sales pitch)'],
  [/\bbook a (free )?(call|demo|meeting|consultation)\b/i, 'asks readers to book a call'],
  [/\bour (agency|services|clients|team helps|offer)\b/i, 'promotes their agency'],
  [/\b(i|we) (offer|provide|specialize in|specialise in)\b/i, 'offers services'],
  [/\bfree (audit|consultation|strategy|trial|training|guide|template|ebook|e-book)\b/i, 'free offer (marketing post)'],
  [/\bcase stud(y|ies)\b/i, 'case study (marketing post)'],
  [/\bcomment\b.{0,15}["'][^"']{1,20}["']/i, 'engagement bait ("comment X")'],
  [/\blink in (the )?(comments?|bio|first comment)\b/i, 'link-in-comments post'],
  [/\bhere'?s (how|what|why)\b/i, 'advice / how-to post'],
  [/\b\d+\s?(\w+\s){0,2}(tips|ways|steps|mistakes|lessons|reasons|strategies|tools|secrets|hacks|signs|truths)\b/i, 'listicle / advice post'],
  [/\b(sound familiar\??|the real question|here are (the |some |a few |\d+)|what most (people|businesses|founders|teams) (get wrong|miss)|isn'?t (just )?about|it'?s not (just )?about|don'?t always (mean|equal)|the truth is|unpopular opinion|hot take)\b/i, 'thought-leadership / advice post'],
  [/\bmy clients\b/i, 'talks about their clients'],
  [/\b(hire me|available for (hire|work|projects|new clients)|taking (on )?new clients|accepting new clients)\b/i, 'freelancer looking for work'],
  [/\b(do you|are you|is your|tired of|stop (wasting|struggling)|want more)\b.{0,60}\?/i, 'sales hook question to the reader'],
  [/\b(we|i) can help\b/i, 'offers help'],
  [/\b(sign up|register|enroll|enrol|join (our|my|the) (course|program|programme|training|webinar|community))\b/i, 'course / sign-up promotion'],
];
const JOB_SEEKER = [
  [/#?open ?to ?work\b/i, 'job seeker (#opentowork)'],
  [/\b(i'?m|i am)\b.{0,40}\b(looking for|seeking|searching for)\b.{0,30}\b(job|role|position|opportunit(y|ies)|clients|projects|work)\b/i, 'job / client seeker'],
  [/\blooking for (a |new |my next )?(job|role|position|remote (job|work|role)|opportunit(y|ies)|clients|projects)\b/i, 'job / client seeker'],
  // "looking for a cleaning company that needs an appointment setter" = a setter looking for a client
  [/\blooking for\b[^.!?\n]{0,30}\b(client|clients|company|companies|business|businesses|brand|team)\b[^.!?\n]{0,25}\b(that|who|which) (needs?|is looking|wants)\b/i, 'job / client seeker'],
  [/\blooking for (an? |new )?[^.!?\n]{0,20}\b(company|client|business|brand)( \w+)? to work with\b/i, 'job / client seeker'],
];
const SPAM = [
  [/\b(new batch|free training|limited seats|work from home|students?|freshers?|housewi\w+|internships?|bootcamp|masterclass|webinar|course)\b/i, 'training / course / WFH spam'],
  [/\b(save your (spot|seat)|reserve your (spot|seat)|grab your (spot|seat)|(register|sign up|rsvp) (now|here|today|for free)|join us (on|this|for|at|live)|workshop|live session|open to any (agent|founder|business)|we'll bring the training|link to register)\b/i, 'event / webinar promotion'],
  [/\b(earn|income|make money|passive income|per day|per month)\b.{0,30}\b(from home|online|\$|usd|rs|pkr|inr)\b/i, 'money-making spam'],
];
// The buyer speaks for themselves
const FIRST_PERSON = /\b(i|i'm|i've|we|we're|we've|our|us|my)\b/i;

// Author headline that shows they SELL these services (= competitor, not a buyer)
const SELLER_HEADLINE = /\b(lead[\s-]?gen\w*|appointment[\s-]?sett\w*|cold[\s-](e-?mail|call\w*|outreach)|outreach (specialist|expert|manager|consultant)|e-?mail market\w* (specialist|expert|consultant|manager|agency)|email deliverability|sdr|bdr|sales development rep\w*|growth hack\w*|demand gen\w*|i help|helping (b2b|businesses|companies|agencies|founders|brands|coaches|startups|saas)|(marketing|growth|lead gen\w*|outbound|sales) agency|freelanc\w*|upwork|fiverr|virtual assistant|\bva\b|b2b (growth|lead\w*|sales) (specialist|expert|consultant)|\d+\+? (agency owners|founders|clients|businesses|companies|brands) helped|get more (of your )?(sales|clients|leads|calls|meetings)|we build|fractional|part[\s-]time cmo)\b/i;

// People you don't want, whatever the post says (Settings → your list): coaches, advisors, speakers …
const AUTHOR_SKIP = [
  [/\b(coach(es|ing)?|advis(o|e)rs?|advisory|strategists?|(keynote |public )?speakers?|authors?|best[\s-]?selling|mentor(s|ing)?|podcast\w*|host of|launching [^|]{0,40}careers?|careers? (accelerator|academy|bootcamp)|(sales|career) training)\b/i, 'coach / advisor / speaker / author / mentor'],
  [/\b(ministr(y|ies)|faith[\s-]?based|christian|church|pastor|gospel|kingdom|jesus|christ|biblical|evangel\w*|(romans|john|psalms?|proverbs|matthew|philippians|jeremiah|isaiah) \d+:\d+)\b/i, 'ministry / faith-based'],
  [/\b(non[\s-]?profit|not[\s-]for[\s-]profit|charity|charitable|ngo|501\s?\(?c\)?\s?\(?3\)?)\b/i, 'nonprofit'],
  [/\b(freelanc\w*|self[\s-]employed|solopreneur|independent (consultant|contractor|professional)|one[\s-](wo)?man (band|show)|upwork|fiverr)\b/i, 'solo freelancer'],
];
const LOCAL_ROLE = /\b((work arrangement|workplace|work type|location type)\s*:?\s*(hybrid|on[\s-]?site|in[\s-]office)|hybrid (role|position|work|schedule|setup)|on[\s-]?site (role|position)|in[\s-]office (role|position)|must be [a-z]+[\s-]based|must (be )?(located|based|living) in|(us|uk|australia|canada)[\s-]based (only|candidates))\b/i;
// Faith posts (scripture, sermons) are never buyers even when the author has no headline
const FAITH_POST = /\b(jesus|scripture|bible|gospel|sermon|amen|lord|holy spirit|god'?s (word|plan|grace))\b/i;

// "Helping cold emailers stay out of spam", "We help SaaS book more meetings" -> sells what we sell
const HELPS_WITH_TOPIC = /\b(help(ing|s)?|i help|we help)\b.{0,60}\b(cold[\s-]?e?mail\w*|outreach|outbound|leads?|lead[\s-]?gen\w*|inbox(es)?|spam|deliverability|appointments?|meetings?|pipeline|prospect\w*|sdrs?|bdrs?|e-?mail (marketing|campaigns?))\b|\b(cold[\s-]?e?mail|outreach|outbound|lead[\s-]?gen\w*|deliverability|appointment[\s-]?sett\w*)\b.{0,30}\b(expert|specialist|consultant|agency|coach|strategist|freelancer|services?)\b/i;
const hits = (rules, text) => rules.filter(([re]) => re.test(text)).map(([, why]) => why);

// Need and topic must be close together (same part of the post), so a long job ad that says
// "looking for a chemist" at the top and "lead generation" in the footer doesn't pass.
function needNearTopic(t, topics = TOPIC) {
  for (const [re] of NEED) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(t))) {
      const around = t.slice(Math.max(0, m.index - 200), m.index + m[0].length + 250);
      if (topics.some(([tr]) => tr.test(around))) return true;
      if (!m[0].length) g.lastIndex++;
    }
  }
  return false;
}
const BUYER_ROLE = String.raw`(lead[\s-]?gen\w*|appointment[\s-]?sett\w*|outreach|outbound|cold[\s-]?(e-?mail|call\w*)|sdrs?|bdrs?|business development|e-?mail market\w*)`;
const STRONG_BUYER = [
  // "We're looking for / hiring / seeking … lead generation agency / partner / specialist"
  new RegExp(String.raw`\b(we'?re|we are|we'?ve been|i'?m|i am|our (team|company|agency|startup) is|currently)\b[^.?!\n]{0,25}\b(looking for|seeking|hiring|looking to (hire|partner|work)|searching for|in need of)\b[^.?!\n]{0,60}\b${BUYER_ROLE}\b[^?\n]{0,60}([.!\n]|$)`, 'i'),
  // "ProPilot is looking for freelance lead generation partners"
  new RegExp(String.raw`\b(is|are)\s+(looking for|hiring|seeking|searching for)\s+(an? |experienced |reliable |freelance |b2b |remote ){0,3}${BUYER_ROLE}\s+(agenc(y|ies)|partners?|compan(y|ies)|vendors?|specialists?|experts?|executives?|freelancers?|reps?|representatives?|associates?|setters?)\b`, 'i'),
  // headline style: "Looking for a Lead Generation Agency (EdTech)" / "Looking for B2B Lead Generation Partners!" – not a question
  new RegExp(String.raw`(^|[\n.!])\s*\W{0,4}\s*(we'?re |we are )?(looking for|hiring|seeking)\s+(an? |experienced |reliable |freelance |b2b |remote ){0,3}${BUYER_ROLE}\s+(agenc(y|ies)|partners?|compan(y|ies)|vendors?|specialists?|experts?|executives?|freelancers?|reps?|representatives?|associates?|setters?)\b(?![^\n.]{0,40}\?)`, 'i'),
];
const SOFT_SELLER_SIGNS = ['asks readers to DM them', 'asks readers to call them (sales pitch)', 'offers services', 'offers help', 'case study (marketing post)', 'training / course / WFH spam', 'promotes their agency', 'sales hook question to the reader'];

// Recruiters post jobs for their clients – the client is the buyer, not them
const RECRUITER_HEADLINE = /\b(helping [^|•]{0,60}\bhire\b|hire (engineers|developers|talent|tech talent)|talent ?ad?qu?isi?tion\w*|recrut\w*|bpo|call cent(er|re)|outsourcing|talent (acquisition|partner|business partner|sourc\w*|scout)|strategic sourcing|recruit\w*|headhunt\w*|staffing|sourcing (specialist|partner|lead)|sourcer|hr (manager|business partner|generalist|executive)|human resources|people (partner|operations))\b/i;
const uniq = (a) => [...new Set(a)];
const words = (list = []) => list.map((w) => String(w).trim()).filter(Boolean);
/** First word / phrase from the list found in the text (whole words, any case), or '' */
const findWord = (text, list) => words(list).find((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) || '';
/** Does a job title match one of the titles you asked for? (all the main words, any order) */
const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', '&', '-', '/', 'remote']);
function matchesTitle(title, wanted = []) {
  const t = norm(title).toLowerCase();
  return words(wanted).find((w) => {
    const parts = norm(w).toLowerCase().split(/[\s/,&()-]+/).filter((x) => x && !STOP.has(x));
    return parts.length && parts.every((x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(er|ers|ment|ing|s)$/, '')}\\w*`, 'i').test(t));
  }) || '';
}
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Extra words from the uploaded CV (Settings: prospect_cv_keywords) -> [regex, reason] rules
const extraRules = (words = []) => words.map((w) => w.trim()).filter(Boolean)
  .map((w) => [new RegExp(`\\b${escRe(w).replace(/\s+/g, '[\\s-]?')}\\w*\\b`, 'i'), `cv: ${w.toLowerCase()}`]);

/** Post -> { keep, score, reasons[], rejects[] } */
// Every check can be switched off per search (filter builder → Rules). Defaults = everything on.
const POST_RULES = { need: true, nearTopic: true, firstPerson: true, builtinTopics: true, sellers: true, seekers: true, spam: true, recruiters: true, english: true };
const JOB_RULES = { similarTitles: true, skipSdr: true, skipNonSales: true, skipStaffing: true, skipSenior: true, skipAgencyPosts: true, skipInternships: true };

function judgePost({ text, headline = '', author = '', isCompany = false }, { extra = [], topics: myTopics = [], excludeWords = [], excludeHeadline = [], postType = 'any', remoteHiring = true, rules = {} } = {}) {
  const R = { ...POST_RULES, ...rules };
  const t = norm(text);
  const h = norm(headline);
  const topics = [...(R.builtinTopics ? TOPIC : []), ...extraRules([...extra, ...myTopics])];
  // A need inside quotes is someone else's words (a dialogue, "a customer may say …"), not the author's
  const own = t.replace(/"[^"]{1,300}"/g, ' … ').replace(/(^|[\s(:])'[^'\n]{3,150}'(?=[\s.,;:!?)]|$)/g, '$1 … ');
  const need = uniq(hits(NEED, own));
  const topic = uniq(hits(topics, t));
  let rejects = uniq([...(R.sellers ? hits(SELLER, t) : []), ...(R.seekers ? hits(JOB_SEEKER, t) : []), ...(R.spam ? hits(SPAM, t) : [])]);
  // "DM me" is normal in a hiring post, and "Do you know a good …?" is a genuine question
  if (need.some((n) => /hiring/.test(n))) rejects = rejects.filter((r) => r !== 'asks readers to DM them');
  if (need.some((n) => /recommendations|who can help/.test(n))) rejects = rejects.filter((r) => r !== 'sales hook question to the reader');
  // A clear first-person "we're looking for / hiring a lead gen agency / partner / specialist" is a buyer,
  // even if the post also says "DM me" or mentions a course / class. ("Looking for lead gen services?" is a seller.)
  const strongBuyer = STRONG_BUYER.some((re) => re.test(own));
  if (strongBuyer) rejects = rejects.filter((r) => !SOFT_SELLER_SIGNS.includes(r));
  if (t.length < 40) rejects.push('too short to judge');
  if (R.english && !isEnglish(text)) rejects.push('not written in English');
  if (R.need && !need.length) rejects.push(hits(NEED, t).length ? 'the need is only in a quote / example, not the author\'s own' : 'no clear need / pain point');
  if (topics.length && !topic.length) rejects.push('not about your topics (lead gen / outreach / email marketing …)');
  if (R.need && R.nearTopic && need.length && topic.length && !needNearTopic(own, topics)) rejects.push('the need is not about lead gen / outreach (topic only mentioned elsewhere)');
  if (R.firstPerson && need.length && !strongBuyer && !FIRST_PERSON.test(own)) rejects.push('not written from the buyer\'s side (no I / we)');
  // Hiring posts must be for a remote role (you work remotely); posts asking for help don't need this
  const hiring = need.some((n) => /hiring/.test(n));
  if (remoteHiring && hiring && !/\b(remote(ly)?|work from (home|anywhere)|wfh|from anywhere|anywhere in the world|worldwide)\b/i.test(own)) rejects.push('hiring post is not for a remote role');
  if (postType === 'hiring' && need.length && !hiring) rejects.push('not a hiring post (this search wants hiring posts)');
  if (postType === 'buyer' && need.length && need.every((n) => /hiring/.test(n))) rejects.push('hiring post (this search wants people asking for help)');
  const bad = findWord(t, excludeWords);
  if (bad) rejects.push(`contains an excluded word ("${bad}")`);
  if (R.recruiters && h && RECRUITER_HEADLINE.test(h)) rejects.push(`posted by a recruiter for a client ("${h.slice(0, 60)}")`);
  if (R.sellers && h && !SELLER_HEADLINE.test(h) && HELPS_WITH_TOPIC.test(h)) rejects.push(`author sells these services ("${h.slice(0, 60)}")`);
  if (R.sellers && h && SELLER_HEADLINE.test(h)) rejects.push(`author sells these services ("${h.slice(0, 60)}")`);
  if (isCompany && need.length && !strongBuyer && !need.some((n) => /hiring|recommend|who can help|outsource|proposals/.test(n))) rejects.push('company page post (marketing content, not a buyer)');
  const who = norm(`${headline} ${author}`);
  if (who.trim()) for (const [re, why] of AUTHOR_SKIP) if (re.test(who)) rejects.push(`author is a ${why} ("${(who.match(re) || [''])[0]}")`);
  if (FAITH_POST.test(t)) rejects.push('faith-based post');
  // a role you can't take: hybrid / on-site / only for people living in one place
  if (LOCAL_ROLE.test(t)) rejects.push(`not a remote role ("${t.match(LOCAL_ROLE)[0]}")`);
  const badHead = h && findWord(h, excludeHeadline);
  if (badHead) rejects.push(`author headline has an excluded word ("${badHead}")`);
  const score = need.length * 3 + topic.length * 2;
  return { keep: !rejects.length, score, reasons: [...need, ...topic], rejects };
}

// ---------------- language: only English posts / jobs ----------------
const EN_WORDS = new Set('the and to of a in for is are we you our your with on be this that will it as at or an have has who can from by i my me us they their not but if so what how do need looking help any all more about which would should work team'.split(' '));
const FOREIGN_WORDS = new Set('de la le les des du et und der die das ein eine ist mit für zu auf nicht wir sie el los las del y en una por para con que es het een van voor niet og og er til af med som ikke att och är för jest na w z nie się pour avec nous vous dans sur une est ou il au aux da di il della che per non sono und oder sowie wird ihre unsere bei vom zum zur'.split(' '));

/** true when the text is written in English (non-Latin script or mostly foreign function words -> false) */
function isEnglish(text) {
  const t = String(text || '');
  const letters = t.match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  if (latin / letters.length < 0.8) return false;
  const words = norm(t).toLowerCase().match(/[a-z']+/g) || [];
  let en = 0;
  let fo = 0;
  for (const w of words) { if (EN_WORDS.has(w)) en++; else if (FOREIGN_WORDS.has(w)) fo++; }
  if (/[æøåßñ¿¡]/i.test(t) && fo >= en) return false;
  if (words.length < 8) return !(fo >= 2 && en === 0); // short text such as a job title: only clear cases
  return en >= fo * 1.5 && en / words.length >= 0.08;
}

// ---------------- other languages: we only work in English ----------------
const LANGS = 'german|french|spanish|italian|dutch|flemish|portuguese|polish|swedish|danish|norwegian|finnish|icelandic|czech|slovak|hungarian|romanian|bulgarian|greek|turkish|arabic|hebrew|russian|ukrainian|croatian|serbian|slovenian|estonian|latvian|lithuanian|catalan|basque|japanese|chinese|mandarin|cantonese|korean|hindi|urdu|bengali|thai|vietnamese|indonesian|malay|tagalog|filipino|nordic|scandinavian|dach|benelux|francophone|germanophone|hispanohablante|deutsch|fran[cç]ais|espa[nñ]ol|italiano|nederlands|portugu[eê]s|polski|svenska|dansk|norsk|suomi';
const LANG_IN_TITLE = new RegExp(`\\b(${LANGS})\\b`, 'i');
const LANG_SKILL = new RegExp([
  `\\b(fluent|fluency|native|mother[- ]tongue|proficien\\w*|business[- ]level|professional[- ]level|working (knowledge|proficiency)|(very )?good|strong|excellent|advanced|conversational|c1|c2|b1|b2|speak\\w*|written and spoken|spoken and written|command of|knowledge of)\\W+(\\w+\\W+){0,4}?(${LANGS})\\b`,
  `\\b(${LANGS})\\W+(\\w+\\W+){0,2}?(speaking|speaker|speakers|language|languages|native|fluen\\w*|skills?|proficien\\w*|is a (plus|must|bonus|advantage)|would be|required|mandatory|essential|preferred|level|c1|c2|b1|b2)\\b`,
  `\\b(${LANGS})\\s*(and|&|or|/|\\+)\\s*english\\b`,
  `\\benglish\\s*(and|&|or|/|\\+)\\s*(${LANGS})\\b`,
  `\\bwith (${LANGS})\\b`,
  `\\blanguages?\\s*(:|required|needed)[^.\\n]{0,40}?\\b(${LANGS})\\b`,
  `\\b(${LANGS}) (market|customers|clients|speaking market)\\b`,
].join('|'), 'i');

/** The other language a job asks for (in the title or anywhere in the posting), or '' */
function otherLanguage(title = '', description = '') {
  const t = norm(title).match(LANG_IN_TITLE);
  if (t) return t[0];
  const d = norm(description).match(LANG_SKILL);
  if (!d) return '';
  return (d[0].match(new RegExp(`\\b(${LANGS})\\b`, 'i')) || [d[0]])[0];
}

// ---------------- jobs ----------------
const JOB_TITLE = /\b(lead[\s-]?gen\w*|lead (research\w*|qualif\w*|sourc\w*)|appointment[\s-]?sett\w*|(meeting|call|sales|high[\s-]ticket|remote|appointment) setter|cold[\s-]?(call\w*|e-?mail\w*|outreach)|outbound (caller|call\w*|specialist|rep\w*|agent|associate|coordinator|executive)|outreach|e-?mail market\w*|email campaign\w*|e-?mail (specialist|executive|coordinator|manager)|prospect(ing|or)\w*|list build\w*|telemarket\w*|telesales|demand gen\w*|bdrs?|business develop(p)?(er|ement|ment)( and \w+)? (rep\w*|representative|executive|associate|specialist|coordinator|manager|officer|consultant|lead)|business developer|(associate|junior|jr\.?) business develop\w*|growth (executive|associate|specialist|representative|marketer|hacker|coordinator|manager)|inside sales (rep\w*|representative|specialist|executive|associate)|partner(ship)?s? (development )?(executive|associate|coordinator|manager|specialist)|partner development (coordinator|executive|associate|specialist))\b/i;
// Lead gen style roles we want; plain sales development (SDR) jobs are excluded on purpose
const LEADGEN_TITLE = /\b(lead[\s-]?gen\w*|lead (research|qualif|sourc)\w*|appointment|cold[\s-]?(call|e-?mail|outreach)\w*|outreach|e-?mail|prospect(ing|or)\w*|list build\w*|telemarket\w*|telesales)\b/i;
// SDR = the sales development job (book meetings for account executives) – excluded on purpose
const SALES_DEV_TITLE = /\b(sales development|sdrs?)\b/i; // BDR / business development roles are allowed
const JOB_TITLE_REJECT = /\b(intern(ship)?|unpaid|volunteer|teacher|tutor|instructor|trainer|machin\w*|operator|technician|scientist|engineer\w*|nurse|physician|(community|health|patient|medical|church|student|youth|faith|public|campus) outreach|outreach (nurse|worker|counsel\w*|educator))\b/i;
// Recruiters / staffing / VA agencies post jobs for their own clients -> not the buyer
const STAFFING_COMPANY = /\b(jobgether|jooble|talent\.com|staffing|recruit\w*|talent|virtual assist\w*|outsourc\w*|bpo|manpower|placement|headhunt\w*|hiring|jobs|careers|employment|workforce|remote (team|staff))\b/i;

/** Job card -> { keep, score, reasons[], rejects[] } */
function judgeJob({ title, company }, { extra = [], titles = [], excludeWords = [], excludeCompanies = [], rules = {} } = {}) {
  const R = { ...JOB_RULES, ...rules };
  const t = norm(title);
  const c = norm(company);
  const rejects = [];
  const cv = extraRules(extra).find(([re]) => re.test(t));
  const mine = matchesTitle(t, titles); // a title you put in this search
  const m = (mine && [mine]) || (R.similarTitles && (t.match(JOB_TITLE) || (!R.skipSdr && t.match(SALES_DEV_TITLE)))) || (cv && t.match(cv[0]));
  if (R.skipSdr && !mine && SALES_DEV_TITLE.test(t) && !LEADGEN_TITLE.test(t)) rejects.push('sales development (SDR) role – excluded');
  // title doesn't say it: not dropped here – the full description decides (judgeJobDetail with needDuties)
  const titleUnclear = !m && !rejects.length;
  if (R.skipNonSales && JOB_TITLE_REJECT.test(t)) rejects.push('not a sales role (intern / engineer / teacher …)');
  if (!isEnglish(title)) rejects.push('job title is not in English');
  const lt = otherLanguage(title);
  if (lt) rejects.push(`needs another language (${lt.toLowerCase()})`);
  const badWord = findWord(t, excludeWords);
  if (badWord) rejects.push(`title has an excluded word ("${badWord}")`);
  const badCo = findWord(c, excludeCompanies);
  if (badCo) rejects.push(`excluded company (${c})`);
  if (!c) rejects.push('no company name');
  else if (R.skipStaffing && STAFFING_COMPANY.test(c)) rejects.push(`posted by a staffing / recruiting / VA company (${c})`);
  return { keep: !rejects.length, titleUnclear, score: m ? 5 : 0, reasons: m ? [`hiring: ${m[0].toLowerCase()}`] : [], rejects };
}

// The work itself, read in the description – for jobs whose title doesn't say it ("Growth Associate", "Account Executive" …)
const DUTIES = [
  [/\blead[\s-]?gen(eration)?\b|\bgenerat\w* (new |qualified )?leads\b/i, 'lead generation'],
  [/\bprospect(ing|s)?\b/i, 'prospecting'],
  [/\bcold[\s-]?(call\w*|e-?mail\w*|outreach)\b/i, 'cold calling / email'],
  [/\b(outbound|outreach)\b/i, 'outreach'],
  [/\b(book|set|schedul\w*)\b.{0,25}\b(meetings|appointments|calls|demos)\b|\bappointment[\s-]?sett\w*\b/i, 'booking meetings'],
  [/\be-?mail (marketing|campaigns?|sequences?)\b|\be-?mail market\w*\b/i, 'email campaigns'],
  [/\b(generat\w*|creat\w*|identif\w*|find\w*|open\w*|source|sourcing)\b.{0,25}\b(new business|(sales |business )?opportunities|new (clients|customers|accounts|logos))\b|\bnew business development\b/i, 'finding new business'],
  [/\blinkedin\b.{0,30}\b(outreach|prospecting|messag\w*|connect\w*)\b|\bsales navigator\b/i, 'LinkedIn outreach'],
  [/\b(build|building|fill|filling|grow|growing)\b.{0,20}\bpipeline\b/i, 'building pipeline'],
  [/\b(qualif(y|ying|ied)|research(ing)?)\b.{0,20}\b(leads|prospects|accounts)\b/i, 'lead research / qualifying'],
  [/\b(apollo|hubspot|salesforce|lemlist|instantly|clay|zoominfo|outreach\.io|salesloft)\b/i, 'outreach tools'],
];

// ---------------- job details (full description) ----------------
const SENIOR_TITLE = /\b(senior|sr\.?|director|vp|vice president|head of|chief|principal|c-level|cmo|cro)\b/i;
// Must talk about WHO can apply / WHERE they can work from – "used by companies worldwide" doesn't count
const GLOBAL_OK = /\b(work from anywhere|work(ing)? remotely from anywhere|from anywhere in the world|anywhere in the world|global(ly)? remote|remote[- ]global|(remote|location)\s*[:(\-–]?\s*(worldwide|global|anywhere)\b|(fully |100% )?remote[,\s]+(worldwide|global(ly)?|anywhere)|(remote|work|working|hire|hiring|candidates|applicants|apply|talent|team members?)\b[^.\n]{0,40}\bworldwide|worldwide\b[^.\n]{0,30}\b(remote|candidates|applicants|talent)|open to (international )?(candidates|applicants|talent|people|anyone) (from|in|across|based in) (any|all|other|every|anywhere)|open to international (candidates|applicants|talent)|(candidates|applicants|talent|contractors) (from|in|based in) (any|all) (country|countries|location)|any (country|location|timezone|time zone)|all countries|location[- ]independent|regardless of (your )?(location|country)|international (candidates|applicants|contractors)|(hire|hiring|recruit) (globally|worldwide|internationally)|(independent )?contractor|freelanc\w*|(latam|emea|apac) (candidates|applicants) (are )?welcome)\b/i;
// Any of these = only people from one country / region can take the job
const LOCAL_ONLY = /\b(based in (europe|the eu|eu|emea|the uk|the us|north america)|(within|in) (europe|the eu|emea) only|(remote|location)\s*[-–:(]\s*(within|in) (europe|the eu|emea|the uk)|(europe|eu|emea)[- ]based|(candidates?|applicants?|you|you'?re|you are|must be|should be)\b[^.]{0,25}\bbased in|must (be )?(located|based|reside|resident|live|living) in|must reside|(us|u\.s\.|uk|canadian|eu) (citizens?|residents?)( only)?|(authorized|authorised|eligible|legally able|permitted) to work in|right to work in|(eu |eea |valid )?work permit( is)? (required|needed|necessary|mandatory)|requires? an? (eu |valid )?work permit|visa sponsorship (is )?not (available|provided|offered|possible)|(cannot|can'?t|unable to|do not|don'?t|will not|won'?t) (offer|provide)( visa)? sponsorship|no (visa )?sponsorship|(eu|uk|eea|europe|eu\/uk|uk\/eu)[- ]?(only|based only|residents only)|within (a )?commut(ing|able) distance|commutable distance|able to commute|within the (us|u\.s\.|united states|uk|canada|eu|eea) only|(us|uk|canada|eu)[- ]based (candidates|applicants) only)\b/i;
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** "work from anywhere" match – and whether it really says "…anywhere in Europe" */
function globalHit(d) {
  const t = noPerks(d);
  const m = t.match(GLOBAL_OK);
  if (!m) return null;
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
  const before = t.slice(Math.max(0, m.index - 30), m.index);
  return { text: m[0], europeOnly: /^\s*(in|within|across)\s+(the\s+)?(europe|eu|eea|emea)\b/i.test(after) || /\b(europe|the eu|eea|emea)\b[\s(,:-]*$/i.test(before) };
}

// Remote across Europe (not tied to one country)
const EUROPE_OK = /\b(anywhere in (europe|the eu|the eea|emea)|(remote|work|working|based|located|live|living)\s+(from\s+)?(anywhere\s+)?(within|across|in) (europe|the eu|the eea|emea)|based in (europe|the eu|the eea|emea)( \(any country\))?|(europe|eu|eea|emea)[- ]based|remote\s*[-–:(,]\s*((within|in|across) )?(the )?(europe|eu|eea|emea)\b\)?|european time ?zones?|(cet|cest|gmt|utc)\s*[±+-]\s*\d|(eu|eea) (residents?|citizens?|nationals?)|(eu|eea|european) (work (permit|authori[sz]ation|visa)|right to work)|right to work in the (eu|eea)|(within|in) (europe|the eu|emea) only|(europe|eu)\s*\/\s*(eea|uk)|in any (eu|european) country)\b/i;

// "work from anywhere up to one month a year" is a perk, not a location rule
const noPerks = (d) => d
  .replace(/\b(up to|for)\s+[^.]{0,30}\b(weeks?|months?|days?)\b[^.]{0,40}\b(from anywhere|anywhere in the world|worldwide)[^.]*/gi, ' ')
  .replace(/\b(from anywhere|anywhere in the world|worldwide)\b[^.]{0,30}\b(up to|for)\s+[^.]{0,20}\b(weeks?|months?|days?)\b[^.]*/gi, ' ')
  .replace(/\b(work from anywhere|workation)\s+(weeks?|days?|program(me)?|policy|budget|allowance)\b/gi, ' ');

/** Years of experience the job REQUIRES (preferred / bonus lines ignored), or null when not stated. */
function requiredYears(desc) {
  const t = norm(desc).toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => WORD_NUM[w]);
  let max = null;
  // English / French / German / Spanish / Italian / Dutch / Polish units
  const re = /(\d{1,2})\s*(\+|plus)?\s*(?:(?:-|–|to|à|a|bis)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?|ans|années|annees|jahre?n?|años|anos|anni|jaar|lat)\b/g;
  const CONTEXT = /experience|exp\b|background|track record|exp[eé]rience|erfahrung|berufserfahrung|experiencia|esperienza|ervaring|do[sś]wiadczeni/;
  let m;
  while ((m = re.exec(t))) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (/^\s*(old|of age|d'age|d'âge|alt\b|de edad)/.test(after) || /\b(aged?|over|minimum age|at least)\s*$/.test(t.slice(Math.max(0, m.index - 15), m.index)) && /old|age/.test(after)) continue;
    const around = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
    if (!CONTEXT.test(around)) continue;
    const end = t.indexOf('.', m.index + m[0].length);
    const sentence = t.slice(t.lastIndexOf('.', m.index) + 1, end === -1 ? undefined : end);
    if (/prefer|bonus|nice to have|plus if|a plus|ideally|desired|souhait|idéalement|wünschenswert|von vorteil|valorable|deseable/.test(sentence)) continue;
    const lo = Number(m[1]);
    if (lo > 15) continue; // ages, company history ("20 years in business")
    max = max === null ? lo : Math.max(max, lo);
  }
  return max;
}

/**
 * Job + full posting -> { keep, reasons[], rejects[] }
 *   country: where the job is; globalOnly: countries whose jobs must be open to applicants worldwide
 */
function judgeJobDetail({ title, description = '', seniority = '', location = '' }, { country, globalOnly = [], globalAll = false, allowEurope = false, requireRemote = false, checkLanguages = true, maxYears = 5, rules = {}, needDuties = false, extra = [] }) {
  const R = { ...JOB_RULES, ...rules };
  const d = norm(description);
  const rejects = [];
  const reasons = [];
  // title didn't say it: the job must really be lead gen / outreach work (2+ different duties, or a CV skill + 1)
  if (needDuties) {
    const duties = uniq(hits(DUTIES, d));
    const cvHit = extraRules(extra).some(([re]) => re.test(d));
    if (duties.length >= 2 || (cvHit && duties.length >= 1)) reasons.push(`the work: ${duties.slice(0, 3).join(', ')}`);
    else rejects.push(duties.length ? `description is only a little about lead gen (${duties.join(', ')})` : 'neither title nor description is about lead gen / outreach / email marketing');
  }
  if (!isEnglish(description)) rejects.push('job posting is not in English');
  else if (checkLanguages) {
    const ld = otherLanguage('', description);
    if (ld) rejects.push(`asks for another language (${ld.toLowerCase()})`);
  }
  if (R.skipAgencyPosts && /\b(on behalf of (a|our|one of our) (partner|client)|for (a|our|one of our) (client|partner company)|our client is (looking|hiring|seeking))\b/i.test(d.slice(0, 600))) rejects.push('posted by an agency for a client');
  if (R.skipSenior && SENIOR_TITLE.test(norm(title))) rejects.push(`senior role ("${title}") – usually more than ${maxYears} years`);
  if (R.skipSenior && /\b(director|executive)\b/i.test(seniority)) rejects.push(`seniority: ${seniority}`);
  if (R.skipInternships && /\b(internship|intern)\b/i.test(d.slice(0, 1500))) rejects.push('internship');
  const yrs = requiredYears(d);
  if (yrs !== null && yrs > maxYears) rejects.push(`asks for ${yrs}+ years of experience (max ${maxYears})`);
  else if (yrs !== null) reasons.push(`${yrs} yrs experience`);
  const remote = /\bremote\b/i.test(`${location} ${title}`) || /\b(remote(ly)?(?! control)|work from (home|anywhere)|wfh|home[- ]based)\b/i.test(d);
  if (requireRemote && !remote) rejects.push('not remote (this search wants remote jobs)');
  else if (globalAll || (country && globalOnly.includes(country))) {
    if (!remote) rejects.push('not remote (jobs must be remote and open to applicants anywhere)');
    else {
      // "Remote within Europe" allowed: Europe-wide wording is fine, a single-country rule is not
      const full = `${title}. ${d}`;
      const europe = allowEurope ? (full.match(EUROPE_OK) || [])[0] : '';
      const rest = allowEurope ? full.replace(new RegExp(EUROPE_OK.source, 'gi'), ' ') : full;
      const local = rest.match(LOCAL_ONLY);
      if (local) rejects.push(`only for applicants in one place ("${local[0]}")`);
      else if (globalHit(d) && !globalHit(d).europeOnly) reasons.push(`open worldwide ("${globalHit(d).text}")`);
      else if (globalHit(d) && allowEurope) reasons.push(`open across Europe ("${globalHit(d).text} in Europe")`);
      else if (europe) reasons.push(`open across Europe ("${europe}")`);
      else if (globalHit(d)) rejects.push(`only for applicants in Europe ("${globalHit(d).text} in Europe")`);
      else rejects.push(allowEurope ? "doesn't say you can apply from anywhere in Europe" : "doesn't say you can apply from anywhere");
    }
  }
  return { keep: !rejects.length, reasons, rejects };
}

/** Age in days of a LinkedIn "posted" label ("12h", "3d", "1w", "2mo", "2 days ago") or ISO date; null if unknown */
function ageDays(posted = '', isoDate = '') {
  if (isoDate && !Number.isNaN(Date.parse(isoDate))) return Math.floor((Date.now() - Date.parse(isoDate)) / 864e5);
  const m = String(posted).toLowerCase().match(/(\d+)\s*(seconds?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|yrs?|y)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  if (/^(mo|months?)$/.test(u)) return n * 30;
  if (/^(y|yrs?|years?)$/.test(u)) return n * 365;
  if (/^(w|weeks?)$/.test(u)) return n * 7;
  if (/^(d|days?)$/.test(u)) return n;
  return 0; // seconds / minutes / hours
}

/** The sentence part where the author states the need ("we are looking for someone to run cold email") */
function needSnippet(text = '') {
  const t = String(text);
  const own = t.replace(/["“][^"”]{1,300}["”]/g, (m) => ' '.repeat(m.length)); // same positions, quotes blanked
  let best = null;
  for (const [re] of NEED) {
    const m = own.match(new RegExp(re.source, 'i'));
    if (m && (best === null || m.index < best.index)) best = { index: m.index, len: m[0].length };
  }
  if (!best) return '';
  const stop = /[.!?\n]/;
  let a = best.index;
  let b = best.index + best.len;
  while (a > 0 && !stop.test(t[a - 1]) && best.index - a < 80) a--;
  while (b < t.length && !stop.test(t[b]) && b - best.index < 160) b++;
  return t.slice(a, b).replace(/^[\s"'“”,;:]+/, '').trim();
}

/**
 * How promising a prospect is, 0–100 (higher = contact first). Posts: how clearly they ask, how new
 * the post is, whether the author decides (founder / CEO / head of …). Jobs: core lead gen title,
 * open worldwide / Europe, low experience, a named hiring person.
 */
const DECIDER = /\b(founder|co-?founder|ceo|owner|managing director|md|president|partner|head of|vp|vice president|director|cmo|cro|chief)\b/i;
function prospectScore(p) {
  const r = String(p.reasons || '');
  const ageD = ageDays(p.posted || '', /^\d{4}-\d{2}-\d{2}/.test(p.posted || '') ? p.posted : '');
  const fresh = ageD == null ? 3 : ageD <= 1 ? 12 : ageD <= 3 ? 8 : ageD <= 7 ? 4 : 0;
  if (p.kind === 'job') {
    let s = 50 + fresh;
    if (/lead[\s-]?gen|appointment|setter|cold|outreach|outbound|telemarket|e-?mail/i.test(p.title || '')) s += 15;
    if (/open worldwide/.test(r)) s += 14; else if (/open across Europe/.test(r)) s += 8;
    const y = (r.match(/(\d+) yrs experience/) || [])[1];
    s += y === undefined ? 4 : Number(y) <= 2 ? 8 : Number(y) <= 3 ? 6 : 2;
    if (p.person_name) s += 5;
    return Math.min(99, s);
  }
  const text = String(p.text || '');
  const own = norm(text).replace(/"[^"]{1,300}"/g, ' ');
  const needs = r.split(', ').filter((x) => /help|recommend|struggl|can't|not enough|dry|spam|hiring|outsource|proposals|who can/i.test(x));
  let s = 35 + fresh;
  if (STRONG_BUYER.some((re) => re.test(own))) s += 20;
  s += Math.min(15, needs.length * 5);
  if (needs.length && needs.every((n) => /hiring/.test(n))) s -= 6; // hiring an employee, not buying a service
  if (DECIDER.test(p.headline || '')) s += 12;
  if (p.company_name) s += 3;
  return Math.max(1, Math.min(99, s));
}

/** Company name from a headline like "Founder at Acme" / "CEO @ Acme | …" */
function companyFromHeadline(h = '') {
  const m = norm(h).match(/(?:\bat\b|@)\s*([^|•·,]{2,60})/i);
  return m ? m[1].trim() : '';
}

module.exports = { prospectScore, POST_RULES, JOB_RULES, matchesTitle, needSnippet, otherLanguage, ageDays, isEnglish, judgePost, judgeJob, judgeJobDetail, requiredYears, companyFromHeadline, norm };
