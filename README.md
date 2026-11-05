# Orbit_Linkedin-Automation

**LinkedIn Outreach, Prospect Finder & Job Applier**

This app repeats the workflow in `linkedin workflow.mov` (screenshots are in `workflow-screenshots/`):

> Sales Navigator saved search → lead → LinkedIn profile (new tab) → **Connect** (or **More → Connect** for 3rd degree) → **Add a note** → personalised message → **Send** → close tab → wait 30–50 s → next lead

It runs in **your own Chrome**, in the tab where LinkedIn is already logged in.

## Tech stack
| Part | Tech | Location |
|---|---|---|
| Backend API | Node.js 22 + Express | `app/src/server.js` |
| Database | SQLite (Node built-in, no server) | `app/data/app.db` |
| Live updates | Server-Sent Events + WebSocket | `/api/events`, `/ext` |
| Dashboard | HTML/CSS/JS (no build step) | `app/public/` → http://localhost:4000 |
| Browser automation | Chrome Extension (Manifest V3) | `chrome-extension/` |
| API testing | Postman collection | `app/postman_collection.json` |

## Requirements
- Node.js 22.13 or newer and Google Chrome. Built and tested on macOS; Windows and Linux are not tested.
- Optional: [Claude Code](https://claude.com/claude-code), logged in. It answers job form questions from your CV and can check posts. Without it those questions wait for your answer.

Your data stays on your computer in `app/data/` (never in git). Every install starts empty and runs on the LinkedIn account logged in to its Chrome. Don't copy `app/data/` to an install used by another account.

## One-time setup
```
git clone https://github.com/AbdullahShahh/Orbit_Linkedin-Automation.git
cd Orbit_Linkedin-Automation/app
npm install
```
1. **Load the extension:** in Chrome, open `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** → select the `chrome-extension` folder. Pin it to the toolbar.
2. Double-click **`Start LinkedIn Bot.command`**. The server starts and the dashboard opens. The extension badge changes to **ON**.
   (If macOS blocks it the first time: right-click → Open.)
3. **For the job applier:** Job Applier → **Settings** → **About you**: add your country, nationality and CV, then set expected salary and years of experience. Add keywords and regions on the Applications page.

## Daily use
1. Open Sales Navigator in Chrome (logged in).
2. Dashboard → **Message Types**: create one per audience (e.g. Bookkeepers, CPAs).
   - Variables: `{first_name}` `{last_name}` `{full_name}` `{company}` `{title}`
   - `[Hi|Hello|Hey]` picks one word at random
   - A line with only `---` separates alternative versions; one is chosen at random per lead
3. **Lists**: paste the Sales Navigator saved-search or lead-list URL and choose its message type.
4. **Dashboard** → (optional: tick lists) → **Start sending**. Pause, Resume and Stop are available at any time.
5. **Settings**: delay min/max (default 30–50 s), daily limit, per-run limit, test mode. Changes apply immediately, even during a run.

Tip: turn on **Test mode (dry run)** in Settings for the first run. The bot then fills in the note but doesn't click Send.

To pick a specific tab: open it → click the extension icon → **Use this tab for automation**.

## Prospects (posts & jobs that need lead gen / outreach help)
Dashboard → **Prospects** → **▶ Find prospects**. The bot searches LinkedIn posts and jobs with the saved searches
(edit / add them on that screen) and keeps only real buyers for lead generation, outbound, cold email and email marketing:

- **Posts:** the poster states a need in their own words (looking for / need help / recommend / struggling / hiring …), close to one of
  those topics. Sellers, agencies, freelancers, job seekers, recruiters, courses, advice and engagement-bait posts are dropped.
  The author's profile is opened (in a background tab) to check where they live and what they do.
- **Jobs:** the title must be a lead gen / appointment setter / outreach / email marketing role (SDR / BDR are dropped). Staffing and VA companies, internships, senior roles
  and jobs asking for more than **5 years** of experience are dropped. Jobs in the **US, UK and Canada** must be remote **and** open to
  applicants worldwide. Other countries (e.g. Europe) don't need that.
- **Never targeted:** Pakistan, India, Africa and Asia (Settings → Prospect finder). If the location, person or company can't be identified, the result is skipped.
- **Upload CV:** Prospects → **📄 Upload CV** (PDF, Word .docx or .txt). The skills found in it (lead gen, appointment setting, cold email, email marketing, LinkedIn outreach, CRM …) become job and post searches named `CV: …`; uploading a new CV replaces them.
- **Only the last week:** posts and jobs older than 7 days are dropped.
- **No sales development jobs:** SDR / BDR roles are dropped; lead generation, appointment setter, cold caller, outreach, email marketing and similar roles are kept.
- **Stays in the background:** posts are read straight from LinkedIn's search results (no scrolling), so nothing is ever brought to the front. The bot works in a collapsed "LinkedIn Bot" tab group in your Chrome window (no extra window); its tabs open in the background and close when a job finishes.
- **English only:** posts and job postings written in another language are dropped, and so are jobs whose title or description asks for any other language ("German speaker", "fluent in French", "Dutch is a plus" …).
- **Europe first:** Settings → *Only target these countries / regions* (default `Europe`, UK included) – people and jobs elsewhere are dropped.
- At most **50 new post prospects and 50 new job prospects per day** (Settings).
- **Plain list:** http://localhost:4000/list shows just names, companies and links (also the **🔗 Open list** button).
- Every result shows who (name + LinkedIn link, or the company), the post / job link and why it matched. **Filtered out** lists
  everything that was dropped, with the reason. Mark people **Contacted** / **Not relevant**, and use **Export CSV**.

## Safety built in
- Random delay between every invitation, plus a separate short pause after skips
- Daily limit and per-run limit
- Stops automatically if LinkedIn shows the weekly invitation limit, or if you run out of personalised notes
- 1st-degree connections and people with a pending invite are skipped. Nobody is contacted twice (deduped by Sales Navigator ID).
- Notes longer than the character limit are trimmed at a word boundary

LinkedIn restricts accounts that send too many invitations. A safe range is 15–25 a day and fewer than ~100 a week.

## API
All endpoints are under `http://localhost:4000/api`. Import `app/postman_collection.json` into Postman to try them.
Main ones: `/types`, `/lists`, `/leads`, `/settings`, `/runner/start|sync|prospects|pause|resume|stop`, `/prospect-searches`, `/prospects`, `/stats`, `/logs`.

## If LinkedIn changes its page layout
All clicking logic is in `chrome-extension/actions.js` (Connect / More / Add a note / Send). After editing it, open `chrome://extensions` and click the reload icon on the extension.
