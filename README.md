# Triple Click: One More Things

## First-time setup
1. Install Node 18+ (https://nodejs.org, LTS).
2. Put your API keys in `keys.env` (or `.env`) in this folder:
   `TMDB_API_KEY=...`, `IGDB_CLIENT_ID=...`, `IGDB_CLIENT_SECRET=...` (Open Library and Deezer need no key).
3. Build the data: `node scripts/build-data.mjs`
   - Reads the RSS feed, extracts every pick, and looks each one up in the right database.
   - `data/classified.json` holds pre-made type guesses (game/movie/tv/book/music/...), so each pick is looked up in ONE database instead of several. Picks not in that file are tried against all of them.
   - Flags: `--no-enrich` (skip lookups), `--feed <url-or-file>`.
4. View it: open `site/index.html` directly (read-only), or run the editing server (below).

## Picks that contain several items
`data/splits.json` lists picks to split into separate entries (e.g. "Inside Out 1 + 2" -> Inside Out, Inside Out 2). Numbered sequels like "X 1 + 2" or "X 1-3" are also split automatically, except series/seasons/books. Each split entry's card shows what it was originally listed as. To split another one, add `"normalised raw text": [{"title": "...", "type": "movie"}]` and rebuild.

## Card details
Each pick's card shows database details: director/writer/studio/cast/runtime for movies; creator/network/seasons/cast for TV; developer/publisher/platforms/genres/rating for games; author/publisher/pages/genres for books; artist/label/tracks for music; publisher/episodes for podcasts. Link buttons use direct links when the databases provide them (IMDb, Steam, Goodreads, ...) and search links otherwise. Site icons are fetched from each site's favicon (Google's favicon service); if offline, a coloured letter is shown instead.
Podcast lookups use Apple's keyless search, which is limited to ~20 requests/minute, so they're throttled (a few seconds each).

## Reviewed fixes
`data/curated.json` holds corrections from a review of the whole database (wrong matches, years, titles, types), keyed by the normalised feed text. Your edits in `data/overrides.json` always win over these. Items with a shared database ID, or the same title, are treated as one item, and its card lists every episode it was a One More Thing in. Add `"group": "Name"` to a curated/override entry to merge things that have no database ID (e.g. "Switch 2 + tariffs" -> "Switch 2").

## Editing in the page (your computer only)
The public site never shows the Edit button; editing exists only when you run the local server. Run `node scripts/server.mjs`, then open http://localhost:5173.
Click any pick, then **Edit**. You can change title, type, year, creator, a custom search term, summary and cover URL.
- **Save & rescan**: saves your edit, then re-runs the lookup for that one entry using the new title/type.
- **Save only**: saves now; the entry shows a dot and a "Rescan" button until you rescan.
- **Reset to auto**: throws away your edits for that entry and rebuilds it from the feed.
Your edits are stored in `data/overrides.json` (keyed by pick id), so they survive full rebuilds. The server only listens on localhost.

## Files
- `scripts/build-data.mjs` - feed parser + lookups (TMDB, IGDB, Open Library, Deezer)
- `scripts/server.mjs` - local server for the editing tools
- `data/classified.json` - pre-classified types; `data/overrides.json` - your edits; `data/legacy.json` - optional old-spreadsheet picks
- `site/` - the web page; `site/data.js` is generated

## "What was said" (transcripts)
`scripts/transcribe-all.py` transcribes the end of each episode on your GPU into `data/transcripts/` (local only, git-ignored; skips episodes already done). `scripts/attach-transcripts.mjs` matches each host's part to their pick and writes `site/said.js`. Up to 800 words of each passage are published (`--max-words` changes that); the full text stays in `data/said.json` on your computer.

## Putting it online (GitHub Pages)
One time:
1. Run `node scripts/attach-transcripts.mjs` so `site/said.js` covers every transcribed episode.
2. On github.com create a new repository (e.g. `ones-more-things`). Free accounts need it to be Public for Pages.
3. First do step 4 below (move the workflow), then in PowerShell, in this folder:
   ```
   git init
   git branch -M main
   git add .
   git status        (check that keys.env and data/transcripts are NOT listed)
   git commit -m "First version"
   git remote add origin https://github.com/YOURNAME/ones-more-things.git
   git push -u origin main
   ```
4. Move the workflow into place: `mkdir .github\workflows` then `move deploy\pages.yml .github\workflows\pages.yml`. (It ships in `deploy/` because Claude isn't allowed to write into `.github/` directly.) Then repo **Settings > Pages > Source: GitHub Actions**.
5. Repo **Settings > Secrets and variables > Actions > New repository secret**, three times: `TMDB_API_KEY`, `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET` (same values as in keys.env).
6. The push in step 3 already starts the first deploy (see the **Actions** tab). The site is then at `https://YOURNAME.github.io/ones-more-things/`.

Automatic updates: `pages.yml` (see the setup step that moves it into `.github/workflows/`) runs every Thursday (06:30 and 18:30 UTC) and on demand (**Actions > Update picks and deploy > Run workflow**). It reads the feed, looks up any new picks, commits `site/data.js` if something changed, and redeploys. Your corrections (`data/curated.json`, `overrides.json`, `splits.json`, `classified.json`) and the lookup cache are in the repo, so those runs stay fast and keep your fixes. If the keys are missing the run stops with a clear error instead of publishing worse data. (GitHub pauses scheduled runs on a repo with no activity for 60 days; the weekly commits below keep it alive, or just click Run workflow.)

Every Thursday, on your computer: double-click **Update-OneMoreThings.bat**. It pulls the latest, adds new picks, transcribes new episodes, attaches the transcripts, lists the new picks so you can check them, then commits and pushes (which redeploys). To fix a wrong new pick, run `node scripts/server.mjs`, edit it, then commit `data/overrides.json` and push (or rerun the .bat). Windows Task Scheduler can run the .bat for you if you'd like it fully automatic.
