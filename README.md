# Orbit_Linkedin-Automation

**LinkedIn Connect Bot (personal)**

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

You don't need Docker. Node.js is installed in `~/.local/node` (no sudo) and added to `~/.zshrc`.

## One-time setup
1. **Load the extension:** in Chrome, open `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** → select the `chrome-extension` folder. Pin it to the toolbar.
2. Double-click **`Start LinkedIn Bot.command`**. The server starts and the dashboard opens. The extension badge changes to **ON**.
   (If macOS blocks it the first time: right-click → Open.)

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

## Safety built in
- Random delay between every invitation, plus a separate short pause after skips
- Daily limit and per-run limit
- Stops automatically if LinkedIn shows the weekly invitation limit, or if you run out of personalised notes
- 1st-degree connections and people with a pending invite are skipped. Nobody is contacted twice (deduped by Sales Navigator ID).
- Notes longer than the character limit are trimmed at a word boundary

LinkedIn restricts accounts that send too many invitations. A safe range is 15–25 a day and fewer than ~100 a week.

## API
All endpoints are under `http://localhost:4000/api`. Import `app/postman_collection.json` into Postman to try them.
Main ones: `/types`, `/lists`, `/leads`, `/settings`, `/runner/start|sync|pause|resume|stop`, `/stats`, `/logs`.

## If LinkedIn changes its page layout
All clicking logic is in `chrome-extension/actions.js` (Connect / More / Add a note / Send). After editing it, open `chrome://extensions` and click the reload icon on the extension.
