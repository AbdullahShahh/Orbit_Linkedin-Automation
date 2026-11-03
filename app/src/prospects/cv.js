// Reads a CV (plain text) and turns the skills / roles it mentions into prospect searches:
// job searches for the matching job titles and post searches for people who need that skill.
// Rule based: each SKILL has the words that detect it in a CV, the job titles to search for and
// the LinkedIn post queries that find buyers. The detected title words are also saved in Settings
// (prospect_cv_keywords) so the job / post filters accept them.

const SKILLS = [
  {
    id: 'lead_gen', label: 'Lead generation', detect: /\blead[\s-]?gen(eration)?\b/i,
    jobs: ['Lead Generation Specialist'], titles: ['lead generation'],
    posts: ['"looking for" "lead generation" OR "need help" "lead generation"'],
  },
  {
    id: 'appointment', label: 'Appointment setting', detect: /\bappointment[\s-]?sett(ing|er)\b|\bbook(ed|ing)? (meetings|calls|appointments)\b/i,
    jobs: ['Appointment Setter'], titles: ['appointment setter', 'appointment setting'],
    posts: ['"looking to hire" "appointment setter" OR "need an appointment setter"'],
  },
  {
    id: 'cold_email', label: 'Cold email', detect: /\bcold[\s-]?e-?mail(s|ing)?\b/i,
    jobs: ['Cold Email Specialist'], titles: ['cold email'],
    posts: ['"looking for" "cold email" OR "cold email" "not working"'],
  },
  {
    id: 'cold_calling', label: 'Cold calling', detect: /\bcold[\s-]?call(s|ing|er)?\b|\btele(marketing|sales)\b/i,
    jobs: ['Cold Caller', 'Telemarketer'], titles: ['cold caller', 'cold calling', 'telemarketer'],
    posts: ['"looking for" "cold caller" OR "need a cold caller"'],
  },
  {
    id: 'email_marketing', label: 'Email marketing', detect: /\be-?mail (marketing|campaigns?|automation|newsletters?)\b|\bbulk e-?mail\b/i,
    jobs: ['Email Marketing Specialist'], titles: ['email marketing'],
    posts: ['"need help" "email marketing" OR "looking for" "email marketing"'],
  },
  {
    id: 'linkedin_outreach', label: 'LinkedIn outreach', detect: /\blinkedin (outreach|lead gen\w*|prospecting|automation|growth)\b|\bsales navigator\b/i,
    jobs: ['LinkedIn Outreach Specialist'], titles: ['linkedin outreach'],
    posts: ['"looking for" "linkedin outreach" OR "linkedin lead generation"'],
  },
  {
    id: 'outreach', label: 'Outbound outreach', detect: /\b(outbound|outreach)\b/i,
    jobs: ['Outreach Specialist', 'Outbound Specialist'], titles: ['outreach', 'outbound'],
    posts: ['"looking for someone" outreach OR "outbound" "not working"'],
  },
  {
    id: 'lead_research', label: 'Lead research / list building', detect: /\b(lead|data|prospect) research\w*\b|\blist[\s-]?building\b|\bdata scraping\b|\blead sourcing\b/i,
    jobs: ['Lead Researcher', 'List Building'], titles: ['lead research', 'list building', 'lead researcher'],
    posts: ['"looking for" "lead list" OR "list building" OR "lead research"'],
  },
  {
    id: 'deliverability', label: 'Email deliverability', detect: /\b(e-?mail )?deliverability\b|\bwarm[\s-]?up\b|\bspf\b|\bdkim\b|\bdmarc\b/i,
    jobs: ['Email Deliverability Specialist'], titles: ['deliverability'],
    posts: ['"emails going to spam" OR "deliverability" "help"'],
  },
  {
    id: 'biz_dev', label: 'Business development', detect: /\bbusiness develop(ment|er)\b|\bbdr\b/i,
    jobs: ['Business Development Executive'], titles: ['business development executive', 'business development manager'],
    posts: ['"looking for" "business development" partner OR freelancer'],
  },
  {
    id: 'crm', label: 'CRM (HubSpot / Salesforce)', detect: /\b(hubspot|salesforce|pipedrive|zoho crm|gohighlevel|crm management)\b/i,
    jobs: ['CRM Specialist'], titles: ['crm specialist', 'crm coordinator', 'crm executive'],
    posts: ['"looking for" "hubspot" expert OR "crm" expert'],
  },
  {
    id: 'copywriting', label: 'Email copywriting', detect: /\b(e-?mail )?copywrit(ing|er)\b/i,
    jobs: ['Email Copywriter'], titles: ['copywriter'],
    posts: ['"looking for" "email copywriter"'],
  },
  {
    id: 'automation', label: 'Outreach tools (Apollo, Instantly, Lemlist, Clay…)', detect: /\b(apollo(\.io)?|instantly|lemlist|smartlead|clay|zoominfo|lusha|reply\.io|woodpecker|expandi|phantombuster|seamless\.ai)\b/i,
    jobs: ['Marketing Automation Specialist'], titles: ['marketing automation'],
    posts: ['"looking for" "apollo" OR "instantly" OR "clay" expert'],
  },
];

// Job markets: US / UK / Canada searches ask for remote jobs (they must be open worldwide anyway)
const REGIONS = {
  us: { label: 'United States', location: 'United States', remote: true },
  uk: { label: 'United Kingdom', location: 'United Kingdom', remote: true },
  ca: { label: 'Canada', location: 'Canada', remote: true },
  eu: { label: 'Europe', location: 'European Union', remote: false },
};

/** CV text -> skills found, with how often and an example line */
function analyzeCv(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  return SKILLS.map((s) => {
    const re = new RegExp(s.detect.source, 'gi');
    const found = t.match(re) || [];
    return found.length ? { id: s.id, label: s.label, count: found.length, example: found[0], jobs: s.jobs, posts: s.posts } : null;
  }).filter(Boolean).sort((a, b) => b.count - a.count);
}

/** Chosen skills + regions -> searches to create, and the title words for the filters */
function searchesFor(skillIds, regionIds = Object.keys(REGIONS)) {
  const out = [];
  const titles = [];
  for (const s of SKILLS.filter((x) => skillIds.includes(x.id))) {
    titles.push(...s.titles);
    for (const job of s.jobs) {
      for (const r of regionIds.map((id) => REGIONS[id]).filter(Boolean)) {
        out.push({ name: `CV: ${job} (${r.label})`, kind: 'jobs', keywords: r.remote ? `${job} remote` : job, location: r.location });
      }
    }
    s.posts.forEach((q, i) => out.push({ name: `CV: ${s.label}${s.posts.length > 1 ? ` ${i + 1}` : ''} (posts)`, kind: 'posts', keywords: q, location: '' }));
  }
  return { searches: out, titles: [...new Set(titles)] };
}

module.exports = { SKILLS, REGIONS, analyzeCv, searchesFor };
