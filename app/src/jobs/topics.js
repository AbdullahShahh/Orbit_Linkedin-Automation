// The same question asked in other words ("What's your expected salary?" / "What are your salary expectations?")
// shares one topic, so one answer of yours fills them all. Keep in step with TOPICS in chrome-extension/actions.js.
const TOPICS = [
  ['salary_current', /\b(current|present|last|existing)\b[^?]*\b(salary|pay|compensation|ctc|income)\b/],
  ['salary_expected', /\b(expect\w*|desired|asking)\b[^?]*\b(salary|pay|compensation|ctc|rate|income)\b|\b(salary|compensation|pay)\b[^?]*\b(expect\w*|desired|requirement)\b/],
  ['notice', /\bnotice period\b|\bhow soon can you (start|join)\b|\bearliest (start|joining) date\b|\bwhen can you (start|join)\b|\bavailab\w+ to start\b/],
  ['linkedin', /\blinked\s?in\b[^?]*\b(profile|url|link)\b|^linked\s?in\b/],
  ['website', /^(personal )?(website|portfolio)\b|\bportfolio (link|url)\b/],
  ['sales_target', /\b(sales|monthly|quarterly|revenue)\b[^?]*\b(target|quota)\b|\bquota\b/],
  ['deal_value', /\b(highest|largest|biggest)\b[^?]*\bdeal\b|\bdeal (size|value)\b/],
  ['hear', /\bhow did you (hear|find|learn|come across)\b/],
  ['pref_lang', /\bpreferred language\b/],
  ['country', /\bwhat country\b|\bcountry of residence\b|\bwhich country\b|^country\b/],
  ['sponsorship', /\bsponsor(ship)?\b/],
  ['auth_here', /\bauthori[sz]ed to work\b[^?]*\b(where you (are )?(located|live|reside|based)|your (current )?(country|location))\b/],
];
const topicOf = (label) => {
  const l = String(label || '').toLowerCase();
  return (TOPICS.find(([, re]) => re.test(l)) || [])[0] || '';
};
// nearly the same question (≥ 75 % of the meaningful words shared) – keep in step with similarAnswer() in actions.js
const STOP = new Set('a an the you your yours do does did have has had are is was were be been being of in on at to for with and or any what which how many much this that these those there their our we us i me my currently current please would will can could should if as by from about into than'.split(' '));
const stemW = (w) => (w.length > 5 ? w.replace(/(ments?|ers?|ing|ed|s)$/, '') : w);
const keyWords = (t) => new Set((String(t || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(stemW));
function similar(a, b) {
  const x = keyWords(a);
  const y = keyWords(b);
  if (x.size < 2 || y.size < 2) return false;
  return [...x].filter((w) => y.has(w)).length / Math.max(x.size, y.size) >= 0.75;
}

module.exports = { topicOf, similar };
