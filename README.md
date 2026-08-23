# The Scouting Report

Daily Premier League career-path guessing game. Static frontend, no login,
no server to run — the "backend" is a scheduled script that commits a new
puzzle file to the repo every day.

## How it's hosted (the whole picture)

**1. Code lives in a GitHub repo.**
Everything here — `lib/`, `scripts/`, `public/`, `data/` — goes in one repo.

**2. The daily job runs on GitHub Actions, not a server you manage.**
`.github/workflows/daily-puzzle.yml` is a scheduled GitHub Action (cron,
05:00 UTC by default). Every day it:
- runs `scripts/daily-puzzle.js`
- which picks the next player, calls API-Football, writes
  `public/puzzles/2026-08-19.json` and `public/puzzles/latest.json`
- commits those files straight back into the repo

No server, no database, no uptime to think about — GitHub runs it for you
on a timer, for free on GitHub's standard Actions minutes for a public repo
(private repos get a smaller free allowance, still generous for one run/day).

**3. The frontend is a static site — deploy `public/` anywhere static.**
`public/index.html` is a single self-contained file that fetches
`./puzzles/latest.json` at load time. Because the puzzle files live in the
same repo/folder, any static host works. Simplest options, roughly
equivalent effort:
- **Netlify** or **Vercel** — connect the GitHub repo, set the publish
  directory to `public/`, done. Both auto-redeploy whenever the repo
  changes — including the daily commit from the Action, so a new puzzle
  going live is fully automatic with zero extra config.
- **GitHub Pages** — same idea, slightly more manual setup (point Pages at
  the `public/` folder or a `gh-pages` branch), but free and simple if you
  want to stay entirely inside GitHub.

Either way: **Action commits new puzzle JSON → host detects the repo
changed → redeploys automatically.** That's the "runs itself" loop end to
end — you don't touch it day to day.

**4. Secrets.**
Add `API_FOOTBALL_KEY` as a GitHub Actions secret (repo Settings → Secrets
and variables → Actions). Never commit the key itself.

## One-time setup (do this before the daily job means anything)

```bash
npm install    # no dependencies yet beyond Node's built-in fetch (Node 18+)
API_FOOTBALL_KEY=xxx node scripts/build-player-pool.js
```

This walks every PL season since 1992/93 and writes `data/player-pool.json`
— the deck the daily job draws from. It's slow (rate-limit-paced) and
expensive in API calls, so it's meant to run once, not on a schedule.
Commit the resulting `data/player-pool.json` to the repo. Re-run it once a
season to top up the pool with newly-eligible players.

## Ongoing manual involvement (be honest with yourself about this)

Two things won't fully run themselves:

- **`data/review-queue.json`** — entries land here when a player's data
  looked incomplete or a league couldn't be mapped to a tier. Worth a
  glance every week or so, not every day.
- **`lib/league-tiers.js` → `MANUAL_STINTS`** — non-league English football
  (tier 5 and below) is where API-Football's coverage is weakest, and it's
  exactly the kind of clue-worthy career stretch (Vardy-style routes) that
  makes this game interesting. Add hand-verified stints here as you notice
  gaps in the review queue.

## Feature notes

**Honours and transfer fees**: `lib/api-football.js` calls two additional
endpoints — `/trophies` (team-level honours: league titles, cup wins —
NOT individual awards like Player of the Month, which API-Football
doesn't expose as structured data) and `/transfers` (fee for the move
that started a stint, e.g. "€45M", "Free", "Loan"). Both cover a
player's whole career in one call and get matched back onto the
relevant stint in `attachTrophiesAndTransfers()` — trophies by season
year + country, transfer fees by year + incoming club name. **Worth
verifying against a live response the first time you run this for
real** — the field names (`league`, `season`, `place`, `type`,
`teams.in`/`teams.out`) follow API-Football's documented schema, but
schemas do drift, and this hasn't been tested against a real API key yet.

**Stale-puzzle fallback**: if the daily Action fails partway through (API
outage, rate limit, etc.), the script errors out *before* writing a new
puzzle file, so `latest.json` simply stays as whatever yesterday's run
produced — nothing gets silently overwritten with broken data. The
frontend separately checks the loaded puzzle's `date` against today's UTC
date and shows a small banner if they don't match, so players aren't
confused into thinking a stale puzzle is today's.

**Theme days**: `THEME_DAYS` in `scripts/daily-puzzle.js` maps weekdays to
a label + a predicate that runs against a candidate's fetched career data
(e.g. "Foreign Import Friday" checks whether their first club was outside
England). Because a player's career shape is only known *after* fetching
it, this works as a preference: the script tries up to `MAX_THEME_ATTEMPTS`
candidates looking for a match, and falls back to publishing without a
theme label if none fit. Add more entries to `THEME_DAYS` as you like.

**Hints**: a lightweight profile lookup (nationality + position) runs once
per puzzle. If available, the frontend shows a "Reveal hint" button that
costs 15 points off whatever the player ends up scoring — separate from
the clue-based scoring, and never a free action.

**Difficulty badge**: a rough heuristic based on the player's total PL
appearances (from the pool file) — 300+ apps = easy, 150–299 = medium,
under 150 = hard. It's a proxy for "well known," not a true difficulty
measure, and worth revisiting once you've seen how it plays in practice.

**Autocomplete**: `scripts/daily-puzzle.js` writes
`public/players-index.json` (id + name only) on every run, sourced from
the pool file. The frontend fetches it for the guess-box dropdown, with a
small bundled fallback list if the fetch fails.

## SEO

- `public/robots.txt` — allows all crawlers. Not strictly required, but its
  absence sometimes flags a warning in tools like Google Search Console.
- `public/og-image.png` — the image shown when the link is shared on social
  media or messaging apps. Static, since social platforms and most crawlers
  don't run JavaScript — they read the meta tags straight from the HTML.
- **Before deploying**, replace every `https://example.com` placeholder in
  `public/index.html`'s `<head>` (canonical URL, `og:url`, `og:image`,
  `twitter:image`) with your real domain — these have to be absolute URLs
  pointing at your actual deployed site, not relative paths, for social
  previews to work correctly.

## Local preview

Static `fetch()` calls don't work off `file://`, so serve `public/` with
any simple local server to preview, e.g.:

```bash
npx serve public
```

Without a puzzle file present it falls back to a bundled demo puzzle
(Jamie Vardy) so the page is inspectable immediately.
