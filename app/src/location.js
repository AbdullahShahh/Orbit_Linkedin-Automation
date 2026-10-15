// Works out which country a LinkedIn / Sales Navigator location string is in, so a list can be
// limited to people who live in its target countries. Purely location-based.
//   "Miami, Florida, United States"   -> United States
//   "Greater Philadelphia"            -> United States (known metro)
//   "Toronto, Ontario, Canada"        -> Canada
//   "Greater London"                  -> United Kingdom
//   "Remote"                          -> null (unclear)

const ALIASES = {
  'united states': ['united states', 'united states of america', 'usa', 'u.s.a.', 'u.s.', 'us', 'america'],
  canada: ['canada'],
  'united kingdom': ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  'united arab emirates': ['united arab emirates', 'uae', 'u.a.e.'],
};

const US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico',
];
const CA_PROVINCES = [
  'ontario', 'quebec', 'québec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia',
  'new brunswick', 'newfoundland and labrador', 'newfoundland', 'prince edward island', 'yukon', 'northwest territories', 'nunavut',
];

// Metro / city names LinkedIn often shows without a country
const CITY_COUNTRY = {
  'united states': [
    'new york city', 'nyc', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia', 'san antonio', 'san diego',
    'dallas', 'fort worth', 'dallas-fort worth', 'san jose', 'austin', 'jacksonville', 'columbus', 'charlotte',
    'indianapolis', 'san francisco', 'bay area', 'seattle', 'denver', 'boston', 'nashville', 'detroit', 'portland',
    'las vegas', 'memphis', 'louisville', 'baltimore', 'milwaukee', 'albuquerque', 'tucson', 'fresno', 'sacramento',
    'kansas city', 'atlanta', 'miami', 'fort lauderdale', 'tampa', 'tampa bay', 'orlando', 'raleigh', 'durham',
    'raleigh-durham', 'minneapolis', 'st. paul', 'minneapolis-st. paul', 'st. louis', 'saint louis', 'pittsburgh',
    'cleveland', 'cincinnati', 'salt lake city', 'richmond', 'new orleans', 'buffalo', 'hartford', 'providence',
    'oklahoma city', 'omaha', 'boise', 'des moines', 'greenville', 'knoxville', 'birmingham, alabama', 'silicon valley',
    'greater new york', 'dfw', 'metroplex', 'twin cities', 'inland empire', 'hampton roads', 'research triangle',
    'baton rouge', 'grand rapids', 'rochester', 'albany', 'syracuse', 'tulsa', 'little rock', 'jackson', 'lexington',
    'savannah', 'charleston', 'columbia', 'chattanooga', 'huntsville', 'mobile', 'pensacola', 'tallahassee', 'gainesville',
    'sarasota', 'naples', 'fort myers', 'palm beach', 'west palm beach', 'boca raton', 'scottsdale', 'mesa', 'el paso',
    'corpus christi', 'lubbock', 'spokane', 'tacoma', 'anchorage', 'honolulu', 'reno', 'colorado springs', 'madison',
    'green bay', 'akron', 'dayton', 'toledo', 'fort wayne', 'lansing', 'ann arbor', 'harrisburg', 'allentown', 'scranton',
    'wilmington', 'trenton', 'newark', 'jersey city', 'stamford', 'new haven', 'worcester', 'springfield', 'portland, maine',
    'burlington', 'manchester, new hampshire', 'bakersfield', 'stockton', 'modesto', 'santa barbara', 'san luis obispo',
    'riverside', 'long beach', 'oakland', 'santa clara', 'palo alto', 'irvine', 'anaheim', 'orange county', 'ventura',
  ],
  canada: ['toronto', 'montreal', 'montréal', 'vancouver', 'calgary', 'edmonton', 'ottawa', 'ottawa-gatineau', 'winnipeg', 'mississauga', 'halifax', 'gta'],
  'united kingdom': ['london', 'manchester', 'liverpool', 'leeds', 'glasgow', 'edinburgh', 'bristol', 'cardiff', 'belfast'],
  australia: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide'],
  india: ['delhi', 'new delhi', 'mumbai', 'bengaluru', 'bangalore', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'gurgaon', 'gurugram', 'noida'],
  pakistan: ['karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad'],
  'united arab emirates': ['dubai', 'abu dhabi', 'sharjah'],
  singapore: ['singapore'],
  philippines: ['manila', 'cebu'],
};

// Other countries (names as LinkedIn writes them). "Georgia" is left out on purpose – it is read as the US state.
const COUNTRIES = [
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia', 'austria', 'azerbaijan',
  'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin', 'bhutan', 'bolivia',
  'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria', 'burkina faso', 'burundi', 'cambodia', 'cameroon',
  'chile', 'china', 'colombia', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czechia', 'czech republic', 'denmark',
  'dominican republic', 'ecuador', 'egypt', 'el salvador', 'estonia', 'ethiopia', 'fiji', 'finland', 'france', 'gabon',
  'gambia', 'germany', 'ghana', 'greece', 'guatemala', 'guinea', 'guyana', 'haiti', 'honduras', 'hong kong', 'hungary',
  'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'ivory coast', "côte d'ivoire", 'jamaica',
  'japan', 'jordan', 'kazakhstan', 'kenya', 'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'liberia', 'libya',
  'lithuania', 'luxembourg', 'macau', 'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritius', 'mexico',
  'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands',
  'new zealand', 'nicaragua', 'niger', 'nigeria', 'north macedonia', 'norway', 'oman', 'pakistan', 'palestine', 'panama',
  'papua new guinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda',
  'saudi arabia', 'senegal', 'serbia', 'sierra leone', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa',
  'south korea', 'korea', 'spain', 'sri lanka', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan',
  'tanzania', 'thailand', 'togo', 'trinidad and tobago', 'tunisia', 'turkey', 'türkiye', 'turkmenistan', 'uganda',
  'ukraine', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text, word) => new RegExp(`(^|[^\\p{L}])${esc(word)}([^\\p{L}]|$)`, 'iu').test(text);

/** Canonical country name for something the user typed ("USA" -> "united states"). */
function normalizeCountry(name = '') {
  const n = String(name).trim().toLowerCase();
  for (const [canon, list] of Object.entries(ALIASES)) if (list.includes(n)) return canon;
  return n;
}

/** Country (lower-case canonical) a location string points to, or null when unclear. */
function countryOf(location = '') {
  const loc = String(location).normalize('NFKC').toLowerCase().trim();
  if (!loc) return null;
  // 1. explicit country words, checked from the end ("…, Florida, United States")
  const parts = loc.split(',').map((p) => p.trim()).reverse();
  for (const p of parts) {
    for (const [canon, list] of Object.entries(ALIASES)) if (list.some((a) => p === a)) return canon;
    if (COUNTRIES.includes(p)) return p;
  }
  // 2. US states / Canadian provinces (before other countries, so "New Mexico" is not Mexico)
  if (US_STATES.some((s) => has(loc, s))) return 'united states';
  if (CA_PROVINCES.some((s) => has(loc, s))) return 'canada';
  // 3. a country name anywhere in the text
  for (const [canon, list] of Object.entries(ALIASES)) if (list.filter((a) => a.length > 3).some((a) => has(loc, a))) return canon;
  for (const c of COUNTRIES) if (has(loc, c)) return c;
  // 4. well-known metros / cities
  for (const [canon, cities] of Object.entries(CITY_COUNTRY)) if (cities.some((c) => has(loc, c))) return canon;
  return null;
}

const parseCountries = (str = '') => String(str).split(',').map(normalizeCountry).filter(Boolean);

/**
 * { ok: true } when the lead may be contacted, else { ok: false, reason }.
 * allowed: "United States, Canada" (empty = no filter). skipUnclear: skip when the country can't be told.
 */
function checkLocation(location, allowed, skipUnclear) {
  const list = parseCountries(allowed);
  if (!list.length) return { ok: true };
  const c = countryOf(location);
  if (!c) return skipUnclear ? { ok: false, reason: `location "${location || 'empty'}" doesn't show a country` } : { ok: true, unclear: true };
  if (list.includes(c)) return { ok: true, country: c };
  return { ok: false, reason: `lives outside the target countries (${location})` };
}

module.exports = { countryOf, checkLocation, parseCountries, normalizeCountry };
