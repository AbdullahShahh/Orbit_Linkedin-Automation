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

// States / counties / regions LinkedIn shows without a country ("Basingstoke, Hampshire", "Hannover, Lower Saxony")
const STATE_COUNTRY = {
  'united kingdom': ['hampshire', 'kent', 'surrey', 'essex', 'sussex', 'east sussex', 'west sussex', 'berkshire', 'buckinghamshire',
    'hertfordshire', 'oxfordshire', 'cambridgeshire', 'norfolk', 'suffolk', 'devon', 'cornwall', 'dorset', 'somerset', 'wiltshire',
    'gloucestershire', 'yorkshire', 'north yorkshire', 'west yorkshire', 'south yorkshire', 'lancashire', 'greater manchester',
    'merseyside', 'cheshire', 'west midlands', 'east midlands', 'staffordshire', 'warwickshire', 'leicestershire', 'nottinghamshire',
    'derbyshire', 'lincolnshire', 'northamptonshire', 'bedfordshire', 'tyne and wear', 'county durham', 'northumberland', 'cumbria',
    'worcestershire', 'shropshire', 'herefordshire', 'greater london', 'midlothian', 'lanarkshire', 'county antrim'],
  germany: ['bavaria', 'bayern', 'lower saxony', 'niedersachsen', 'north rhine-westphalia', 'nordrhein-westfalen', 'baden-wurttemberg',
    'baden-württemberg', 'hesse', 'hessen', 'saxony', 'sachsen', 'rhineland-palatinate', 'schleswig-holstein', 'brandenburg',
    'thuringia', 'saxony-anhalt', 'mecklenburg-vorpommern', 'saarland'],
  netherlands: ['north holland', 'south holland', 'noord-holland', 'zuid-holland', 'utrecht', 'north brabant', 'noord-brabant', 'gelderland', 'overijssel', 'groningen', 'friesland', 'limburg'],
  spain: ['catalonia', 'cataluna', 'andalusia', 'andalucia', 'community of madrid', 'valencian community', 'basque country', 'galicia'],
  france: ['ile-de-france', 'île-de-france', 'auvergne-rhone-alpes', 'provence-alpes-cote d\'azur', 'occitanie', 'nouvelle-aquitaine', 'hauts-de-france', 'grand est', 'brittany', 'bretagne'],
  italy: ['lombardy', 'lombardia', 'lazio', 'piedmont', 'piemonte', 'veneto', 'emilia-romagna', 'tuscany', 'toscana', 'campania', 'sicily'],
  australia: ['new south wales', 'queensland', 'western australia', 'south australia', 'tasmania', 'australian capital territory'],
  ireland: ['county dublin', 'county cork', 'county galway', 'county limerick'],
  // blocked countries – so these are always recognised
  pakistan: ['sindh', 'khyber pakhtunkhwa', 'balochistan', 'islamabad capital territory', 'azad kashmir', 'gilgit-baltistan'],
  india: ['punjab', 'maharashtra', 'karnataka', 'tamil nadu', 'gujarat', 'uttar pradesh', 'west bengal', 'telangana', 'kerala',
    'rajasthan', 'haryana', 'madhya pradesh', 'bihar', 'odisha', 'andhra pradesh', 'national capital territory of delhi', 'uttarakhand', 'jharkhand', 'assam', 'goa'],
  philippines: ['metro manila', 'national capital region', 'calabarzon', 'central visayas', 'davao region', 'central luzon'],
  bangladesh: ['dhaka division', 'chittagong division', 'chattogram division'],
  nigeria: ['lagos state', 'federal capital territory', 'rivers state', 'oyo state'],
  kenya: ['nairobi county', 'mombasa county'],
};

// Metro / city names LinkedIn often shows without a country
const CITY_COUNTRY = {
  netherlands: ['amsterdam', 'rotterdam', 'the hague', 'eindhoven', 'utrecht'],
  germany: ['berlin', 'munich', 'hamburg', 'frankfurt', 'cologne', 'dusseldorf', 'stuttgart', 'leipzig'],
  ireland: ['dublin', 'cork', 'galway', 'limerick'],
  denmark: ['copenhagen', 'aarhus', 'odense', 'aalborg'],
  sweden: ['stockholm', 'gothenburg', 'malmo'],
  finland: ['helsinki', 'espoo', 'tampere'],
  norway: ['oslo', 'bergen', 'trondheim'],
  belgium: ['brussels', 'antwerp', 'ghent'],
  switzerland: ['zurich', 'geneva', 'basel', 'lausanne', 'bern'],
  austria: ['vienna', 'graz', 'salzburg', 'linz'],
  spain: ['madrid', 'barcelona', 'valencia', 'seville', 'malaga'],
  portugal: ['lisbon', 'porto'],
  poland: ['warsaw', 'krakow', 'wroclaw', 'gdansk', 'poznan'],
  estonia: ['tallinn', 'tartu'],
  'czech republic': ['prague', 'brno'],
  france: ['paris', 'lyon', 'marseille'],
  italy: ['milan', 'rome', 'turin'],
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
  india: ['delhi', 'new delhi', 'mumbai', 'bengaluru', 'bangalore', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'gurgaon', 'gurugram', 'noida',
    'jaipur', 'lucknow', 'indore', 'kochi', 'chandigarh', 'surat', 'nagpur', 'coimbatore', 'mohali', 'vadodara', 'bhopal', 'thiruvananthapuram', 'visakhapatnam'],
  pakistan: ['karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'peshawar', 'sialkot', 'gujranwala', 'quetta', 'hyderabad'],
  'united arab emirates': ['dubai', 'abu dhabi', 'sharjah', 'ajman'],
  singapore: ['singapore'],
  philippines: ['manila', 'cebu', 'davao', 'makati', 'quezon city', 'taguig', 'pasig'],
  bangladesh: ['dhaka', 'chittagong', 'chattogram'],
  nigeria: ['lagos', 'abuja', 'ibadan', 'port harcourt'],
  kenya: ['nairobi', 'mombasa'],
  egypt: ['cairo', 'alexandria', 'giza'],
  'south africa': ['johannesburg', 'cape town', 'durban', 'pretoria'],
  ghana: ['accra', 'kumasi'],
  vietnam: ['ho chi minh', 'hanoi', 'da nang'],
  indonesia: ['jakarta', 'bandung', 'surabaya', 'bali'],
  malaysia: ['kuala lumpur', 'penang', 'johor bahru'],
  thailand: ['bangkok', 'chiang mai'],
  'saudi arabia': ['riyadh', 'jeddah', 'dammam'],
  qatar: ['doha'],
  'sri lanka': ['colombo'],
  nepal: ['kathmandu'],
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
  "cote d'ivoire", 'turkiye', 'south sudan', 'eritrea', 'djibouti', 'chad', 'congo', 'democratic republic of the congo',
  'equatorial guinea', 'cape verde', 'cabo verde', 'comoros', 'seychelles', 'lesotho', 'eswatini', 'guinea-bissau',
  'mauritania', 'central african republic', 'sao tome and principe', 'timor-leste', 'north korea', 'macao',
];

// Regions that can be blocked by name (Settings → "Don't target these countries / regions")
const AFRICA = [
  'algeria', 'angola', 'benin', 'botswana', 'burkina faso', 'burundi', 'cameroon', 'cape verde', 'cabo verde',
  'central african republic', 'chad', 'comoros', 'congo', 'democratic republic of the congo', 'djibouti', 'egypt',
  'equatorial guinea', 'eritrea', 'eswatini', 'ethiopia', 'gabon', 'gambia', 'ghana', 'guinea', 'guinea-bissau',
  'ivory coast', "côte d'ivoire", "cote d'ivoire", 'kenya', 'lesotho', 'liberia', 'libya', 'madagascar', 'malawi', 'mali',
  'mauritania', 'mauritius', 'morocco', 'mozambique', 'namibia', 'niger', 'nigeria', 'rwanda', 'sao tome and principe',
  'senegal', 'seychelles', 'sierra leone', 'somalia', 'south africa', 'south sudan', 'sudan', 'tanzania', 'togo',
  'tunisia', 'uganda', 'zambia', 'zimbabwe',
];
const REGIONS = {
  africa: AFRICA,
  'south asia': ['afghanistan', 'bangladesh', 'bhutan', 'india', 'maldives', 'nepal', 'pakistan', 'sri lanka'],
  'east asia': ['china', 'hong kong', 'macau', 'macao', 'japan', 'mongolia', 'north korea', 'south korea', 'korea', 'taiwan'],
  'southeast asia': ['brunei', 'cambodia', 'indonesia', 'laos', 'malaysia', 'myanmar', 'philippines', 'singapore', 'thailand', 'timor-leste', 'vietnam'],
  'central asia': ['kazakhstan', 'kyrgyzstan', 'tajikistan', 'turkmenistan', 'uzbekistan'],
  'middle east': ['bahrain', 'iran', 'iraq', 'israel', 'jordan', 'kuwait', 'lebanon', 'oman', 'palestine', 'qatar', 'saudi arabia',
    'syria', 'turkey', 'türkiye', 'turkiye', 'united arab emirates', 'yemen', 'armenia', 'azerbaijan', 'cyprus'],
};
REGIONS.asia = [...REGIONS['south asia'], ...REGIONS['east asia'], ...REGIONS['southeast asia'], ...REGIONS['central asia'], ...REGIONS['middle east']];

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
  // accents removed, so "Islāmābād" reads as "islamabad"
  const loc = String(location).normalize('NFD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase().trim();
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
  // 4. well-known metros / cities, then states / counties / regions
  for (const [canon, cities] of Object.entries(CITY_COUNTRY)) if (cities.some((c) => has(loc, c))) return canon;
  for (const [canon, states] of Object.entries(STATE_COUNTRY)) if (states.some((st) => has(loc, st))) return canon;
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

/** Countries named in a block setting like "Pakistan, India, Africa, Asia" (regions expand to their countries). */
function blockedCountries(str = '') {
  const out = new Set();
  for (const name of parseCountries(str)) for (const c of REGIONS[name] || [name]) out.add(c);
  return out;
}

/**
 * Is a location in a blocked country / region?
 * { ok: true, country } | { ok: false, reason, unclear? } – unclear locations are NOT ok (we can't prove they're allowed).
 */
function checkBlocked(location, blocked) {
  const set = blockedCountries(blocked);
  const c = countryOf(location);
  if (!c) return { ok: false, unclear: true, reason: `location unclear ("${location || 'not shown'}")` };
  if (set.has(c)) return { ok: false, country: c, reason: `in a blocked country (${location})` };
  return { ok: true, country: c };
}

// Names that are also common first names / words – not used when scanning free text
const AMBIGUOUS_IN_TEXT = new Set(['chad', 'jordan', 'georgia', 'turkey', 'guinea', 'niger', 'mali', 'oman', 'columbia', 'jackson', 'mobile', 'naples', 'hyderabad']);

/** First blocked country (or one of its big cities) mentioned anywhere in a text, else null. */
function mentionsBlocked(text, blocked) {
  const t = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  for (const c of blockedCountries(blocked)) {
    if (!AMBIGUOUS_IN_TEXT.has(c) && has(t, c)) return c;
    for (const city of CITY_COUNTRY[c] || []) if (!AMBIGUOUS_IN_TEXT.has(city) && has(t, city)) return c;
  }
  return null;
}

const EUROPE = ['albania', 'andorra', 'austria', 'belarus', 'belgium', 'bosnia and herzegovina', 'bulgaria', 'croatia', 'cyprus',
  'czechia', 'czech republic', 'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'iceland', 'ireland',
  'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'moldova', 'monaco', 'montenegro', 'netherlands', 'north macedonia',
  'norway', 'poland', 'portugal', 'romania', 'serbia', 'slovakia', 'slovenia', 'spain', 'sweden', 'switzerland', 'ukraine', 'united kingdom'];

REGIONS.europe = EUROPE;

/** Is a location inside the target countries / regions ("Europe", "Germany, Ireland")? Empty target = anywhere. */
function checkTarget(location, target) {
  const want = blockedCountries(target);
  if (!want.size) return { ok: true };
  const c = countryOf(location);
  if (!c) return { ok: false, unclear: true, reason: `location unclear ("${location || 'not shown'}")` };
  return want.has(c) ? { ok: true, country: c } : { ok: false, reason: `outside your target regions (${c})` };
}

module.exports = { checkTarget, countryOf, checkLocation, parseCountries, normalizeCountry, checkBlocked, blockedCountries, mentionsBlocked, REGIONS, EUROPE };
