// Message templates.
//  Variables : {first_name} {last_name} {full_name} {company} {title}
//  Variants  : put a line containing only --- between versions; one is picked at random per lead
//  Spin text : [Hi|Hello|Hey] picks one option at random

const CREDENTIALS = /\b(CPA|CPB|MBA|PhD|CFP|CMA|EA|CFE|PMP|MSc|BSc|Jr\.?|Sr\.?|II|III)\b\.?/gi;
const PREFIXES = /^(dr|mr|mrs|ms|miss|prof)\.?$/i;

function cleanName(full = '') {
  const cleaned = String(full)
    .normalize('NFKC')
    .replace(/\(.*?\)/g, ' ')
    .split(',')[0]
    .replace(CREDENTIALS, ' ')
    .replace(/[^\p{L}\p{M}\s'\-.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter((p) => p && !PREFIXES.test(p));
  const cap = (s) =>
    s && (s === s.toUpperCase() || s === s.toLowerCase()) ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s || '';
  return {
    first_name: cap(parts[0] || ''),
    last_name: cap(parts.length > 1 ? parts[parts.length - 1] : ''),
    full_name: parts.map(cap).join(' '),
  };
}

function variants(template = '') {
  return template
    .split(/^\s*---\s*$/m)
    .map((t) => t.trim())
    .filter(Boolean);
}

function render(template, lead = {}, rand = Math.random) {
  const vs = variants(template);
  if (!vs.length) return '';
  let text = vs[Math.floor(rand() * vs.length)];
  const n = cleanName(lead.name || lead.full_name || '');
  const vars = {
    first_name: lead.first_name || n.first_name || 'there',
    last_name: n.last_name,
    full_name: n.full_name || lead.name || '',
    company: lead.company || '',
    title: lead.title || '',
  };
  text = text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  text = text.replace(/\[([^\[\]]*\|[^\[\]]*)\]/g, (m, opts) => {
    const o = opts.split('|');
    return o[Math.floor(rand() * o.length)];
  });
  return text.replace(/[ \t]+/g, ' ').replace(/ +([,.!?])/g, '$1').trim();
}

// Trim to LinkedIn's character limit at a word boundary
function fitToLimit(text, max) {
  if (!max || text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return { text: (at > max * 0.7 ? cut.slice(0, at) : cut).trim(), truncated: true };
}

/** Picks the active variant used least so far in this type (ties at random). */
function pickVariant(db, typeId) {
  const rows = db.prepare(`
    SELECT v.*, (SELECT COUNT(*) FROM leads d WHERE d.variant_id = v.id AND d.status = 'sent') AS used
    FROM message_variants v WHERE v.type_id = ? AND v.active = 1`).all(typeId);
  if (!rows.length) return null;
  const min = Math.min(...rows.map((r) => r.used));
  const pool = rows.filter((r) => r.used === min);
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { pickVariant, render, cleanName, variants, fitToLimit };
