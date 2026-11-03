// Second opinion on a post that passed the keyword rules: Claude reads it and says if the author is a
// real client (needs lead gen help / hires a remote setter or SDR) or not (seller, advice post, coach …).
// Uses the Claude Code app on this Mac (`claude -p`, your own login) – no API key needed.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const CLAUDE = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => fs.existsSync(p)) || 'claude';

const SYSTEM = 'You classify LinkedIn posts. Reply only with the JSON asked for.';

const prompt = (p) => `You screen LinkedIn posts for a freelancer who sells B2B lead generation, LinkedIn outreach, cold email, email marketing and appointment setting (works remotely).
Decide if the AUTHOR is a real potential client. Two kinds COUNT as clients:
1) they themselves need this help now (asking for an agency / freelancer / recommendations, saying their own pipeline or leads are a problem);
2) they are hiring someone for remote appointment setting / SDR / BDR / lead generation / outreach / cold calling / email marketing work (the freelancer applies or offers the work as a service) - commission-only is fine.
NOT a client: people or companies who sell these services, marketers or consultants writing advice / thought-leadership / opinion content, coaches, advisors, strategists, speakers, authors, mentors, podcast hosts, faith-based or nonprofit posts, solo freelancers, job seekers, recruiters for other companies, on-site or hybrid roles.
Answer ONLY with JSON: {"client": true|false, "reason": "<max 12 words>"}

Author: ${p.author_name}${p.author_kind === 'company' ? ' (company page)' : ''}
Headline: ${p.headline || '-'}
Post:
${String(p.text || '').slice(0, 2500)}`;

/** { client: true|false, reason } – or { error } when Claude could not answer (the post is then kept) */
function judgeWithClaude(post) {
  return new Promise((resolve) => {
    // Minimal call: own short system prompt, no tools / MCP / skills / settings – ~600 tokens instead of ~20,000
    const args = ['-p', prompt(post), '--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', SYSTEM];
    const child = execFile(CLAUDE, args, { timeout: 120000, cwd: os.tmpdir(), maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return resolve({ error: err.killed ? 'no answer in 2 minutes' : String(err.message).split('\n')[0] });
      try {
        const text = String(JSON.parse(out).result || '');
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        resolve({ client: j.client === true, reason: String(j.reason || '').slice(0, 120) });
      } catch {
        resolve({ error: 'answer not readable' });
      }
    });
    child.stdin.end(); // nothing on stdin – otherwise claude waits 3 s for it
  });
}

module.exports = { judgeWithClaude };
