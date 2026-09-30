// scripts/build-player-pool.js
//
// ONE-TIME (or occasional) setup script — NOT part of the daily job.
// Walks every Premier League season from 1992/93 to the current one,
// sums each player's total PL appearances, and writes out the pool of
// players meeting the eligibility bar (default: 100+ PL appearances).
//
// This is slow and rate-limit-heavy by design (hundreds of calls) —
// run it locally or as a manual GitHub Action, not on a daily schedule.
// Re-run it once a season to pick up newly-eligible players.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/build-player-pool.js

const fs = require("fs");
const path = require("path");
const { getPlayersForSeason, getPlayerProfile, sleep } = require("../lib/api-football");
const { looksAbbreviated, findFullName } = require("../lib/name-normalize");

const PL_LEAGUE_ID = 39;
const START_SEASON = 1992;
const CURRENT_SEASON = new Date().getFullYear();
const MIN_PL_APPEARANCES = 100;
// Pause between requests, tuned to your API-Football plan's per-minute
// rate limit (not the daily cap — a separate, faster-refilling limit).
// Official limits: Free = 10/min, Pro = 300/min (5/sec), Ultra = 450/min,
// Mega = 900/min. This value should be safely UNDER one request interval
// for your tier — e.g. Pro's 5/sec allows ~200ms between calls; 300ms
// leaves a safety margin. If you're still on Free, use ~6500ms instead.
const REQUEST_PAUSE_MS = 300;

const OUTPUT_PATH = path.join(__dirname, "../data/player-pool.json");

function loadExistingPool() {
  if (!fs.existsSync(OUTPUT_PATH)) return new Map();
  const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  return new Map(existing.map((p) => [p.id, p]));
}

// Normalizes a newly-built pool entry's display name to "Firstname Lastname"
// via a profile lookup — but only when the raw API name actually looks
// abbreviated ("K. Tierney"), to avoid spending an extra API call on the
// (majority of) names that are already in the target format. Tries several
// recent seasons (not just the current one), since API-Football only
// returns a profile for a season the player actually has stats in — a
// newly-eligible player added by THIS run is likely still active, so this
// mostly matters for anyone whose eligibility only became apparent after
// their career had already wound down.
async function normalizeName(id, rawName) {
  if (!looksAbbreviated(rawName)) return rawName;

  return findFullName(id, rawName, {
    getPlayerProfile,
    sleep,
    requestPauseMs: REQUEST_PAUSE_MS,
    startSeason: CURRENT_SEASON,
  });
}

async function buildPool() {
  const totals = {}; // playerId -> { name, totalApps }
  const failures = [];

  for (let season = START_SEASON; season <= CURRENT_SEASON; season++) {
    let page = 1;
    let more = true;

    while (more) {
      try {
        const resp = await getPlayersForSeason(PL_LEAGUE_ID, season, page);

        for (const entry of resp) {
          const id = entry.player.id;
          const name = entry.player.name;
          const apps = entry.statistics?.[0]?.games?.appearences || 0;

          if (!totals[id]) totals[id] = { name, totalApps: 0 };
          totals[id].totalApps += apps;
        }

        more = resp.length === 20;
        page++;
      } catch (err) {
        console.error(`[build-pool] failed season ${season} page ${page}: ${err.message}`);
        failures.push({ season, page, error: err.message });
        more = false;
      }

      await sleep(REQUEST_PAUSE_MS);
    }

    console.log(`[build-pool] finished season ${season}, players so far: ${Object.keys(totals).length}`);
  }

  // Preserve `used` state (and any already-normalized name) for players
  // already in the pool from a previous run — this script used to
  // unconditionally set `used: false` for everyone on every re-run, which
  // would silently wipe out the daily job's tracking of which players have
  // already been featured, causing already-published players to reappear.
  const existingPool = loadExistingPool();

  const eligible = Object.entries(totals).filter(([, v]) => v.totalApps >= MIN_PL_APPEARANCES);

  const pool = [];
  for (const [id, v] of eligible) {
    const numericId = Number(id);
    const existing = existingPool.get(numericId);

    const name = existing?.name ?? (await normalizeName(numericId, v.name));

    pool.push({
      id: numericId,
      name,
      totalPlApps: v.totalApps,
      used: existing?.used ?? false,
    });
  }

  pool.sort((a, b) => b.totalPlApps - a.totalPlApps);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(pool, null, 2));

  const newCount = pool.filter((p) => !existingPool.has(p.id)).length;
  console.log(`[build-pool] wrote ${pool.length} eligible players to ${OUTPUT_PATH} (${newCount} new, ${pool.length - newCount} carried over with existing used/name state).`);
  if (failures.length) {
    console.warn(`[build-pool] ${failures.length} season/page requests failed — review and re-run if needed.`);
  }
}

buildPool().catch((err) => {
  console.error("[build-pool] fatal error:", err);
  process.exit(1);
});
