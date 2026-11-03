// Answers Easy Apply questions the bot has no saved answer for, from your CV (data/job_cv.txt).
// Claude (`claude -p`, the Claude Code app on this Mac, your own login) writes a very short answer, or
// says it can't tell from the CV – those questions still come to you (visa, salary, notice period …).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { DATA_DIR } = require('../db');

const CLAUDE = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => fs.existsSync(p)) || 'claude';
const CV_FILE = path.join(DATA_DIR, 'job_cv.txt');

const cvText = () => { try { return fs.readFileSync(CV_FILE, 'utf8').trim(); } catch { return ''; } };
const saveCv = (text) => fs.writeFileSync(CV_FILE, String(text || '').trim());

const SYSTEM = 'You fill in job application forms for the candidate whose CV you get. Reply only with the JSON asked for.';

function prompt(questions, cv, job, known = {}) {
  const qs = questions.map((q, i) => `${i + 1}. key: ${q.key}\n   question: ${q.label}\n   type: ${q.kind}${q.options && q.options.length ? `\n   options (answer with one of these exactly${q.kind === 'checkbox' ? ', several separated by "; "' : ''}): ${q.options.join(' | ')}` : ''}${q.error ? `\n   the form said: ${q.error}` : ''}`).join('\n');
  return `Job: ${job.title} at ${job.company} (${job.location || 'remote'})

Candidate CV:
${cv.slice(0, 7000)}

Other facts about the candidate (from earlier forms):
${Object.entries(known).map(([q, a]) => `- ${q}: ${a}`).join('\n') || '- none'}
- applies through LinkedIn (Easy Apply); prefers English; works remotely

Answer each application question for this candidate, using ONLY these facts and the CV.
- Simple form questions have obvious answers: how you heard about the job -> LinkedIn; preferred language -> English; country -> the country of the candidate's location; consent to data processing / GDPR / privacy -> Yes (agree).
- Keep answers as short as the field allows: a number for "how many years" / numeric fields (whole number), "Yes" / "No" for yes-no, one option exactly as written when options are given, otherwise one short to-the-point sentence (max 25 words) in first person.
- Yes / No questions about experience, industries, tools or skills: Yes when the CV supports it, No when the CV does not mention it (be honest – never claim experience the CV doesn't show).
- If the CV does not tell (visa, work permit, citizenship, salary, notice period, start date, references, personal or legal matters, anything you would have to guess), use null.
Reply ONLY with JSON: {"<key>": "<answer>" | null, ...}

Questions:
${qs}`;
}

/** { key: answer } for the questions the CV answers (others left out) – {} when Claude is not available */
function answerFromCv(questions, job, known = {}) {
  const cv = cvText();
  if (!cv || !questions.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const args = ['-p', prompt(questions, cv, job, known), '--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', SYSTEM];
    const child = execFile(CLAUDE, args, { timeout: 120000, cwd: os.tmpdir(), maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return resolve({ error: err.killed ? 'no answer in 2 minutes' : String(err.message).split('\n')[0] });
      try {
        const text = String(JSON.parse(out).result || '');
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        const outMap = {};
        for (const q of questions) {
          const a = j[q.key];
          if (a == null || String(a).trim() === '' || /^(null|unknown|n\/a)$/i.test(String(a).trim())) continue;
          outMap[q.key] = String(a).trim().slice(0, 400);
        }
        resolve(outMap);
      } catch {
        resolve({ error: 'answer not readable' });
      }
    });
    child.stdin.end();
  });
}

module.exports = { answerFromCv, cvText, saveCv, CV_FILE };
