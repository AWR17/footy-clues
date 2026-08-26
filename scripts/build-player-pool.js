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
const { getPlayersForSeason, sleep } = require("../lib/api-football");

const PL_LEAGUE_ID = 39;
const START_SEASON = 1992;
const CURRENT_SEASON = new Date().getFullYear();
const MIN_PL_APPEARANCES = 100; // raised from 50 — a higher bar filters toward more established players, who are statistically more likely to have a well-documented career throughout (not just their PL years), reducing how often obscure early-career clubs hit data gaps like "unspecified league"
// Pause between requests, tuned to your API-Football plan's per-minute
// rate limit (not the daily cap — a separate, faster-refilling limit).
// Official limits: Free = 10/min, Pro = 300/min (5/sec), Ultra = 450/min,
// Mega = 900/min. This value should be safely UNDER one request interval
// for your tier — e.g. Pro's 5/sec allows ~200ms between calls; 300ms
// leaves a safety margin. If you're still on Free, use ~6500ms instead.
const REQUEST_PAUSE_MS = 300;

const OUTPUT_PATH = path.join(__dirname, "../data/player-pool.json");

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

        more = resp.length === 20; // API-Football pages at 20 results/page
        page++;
      } catch (err) {
        console.error(`[build-pool] failed season ${season} page ${page}: ${err.message}`);
        failures.push({ season, page, error: err.message });
        more = false; // move on to next season rather than looping forever
      }

      await sleep(REQUEST_PAUSE_MS);
    }

    console.log(`[build-pool] finished season ${season}, players so far: ${Object.keys(totals).length}`);
  }

  const pool = Object.entries(totals)
    .filter(([, v]) => v.totalApps >= MIN_PL_APPEARANCES)
    .map(([id, v]) => ({
      id: Number(id),
      name: v.name,
      totalPlApps: v.totalApps,
      used: false,
    }))
    .sort((a, b) => b.totalPlApps - a.totalPlApps);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(pool, null, 2));

  console.log(`[build-pool] wrote ${pool.length} eligible players to ${OUTPUT_PATH}`);
  if (failures.length) {
    console.warn(`[build-pool] ${failures.length} season/page requests failed — review and re-run if needed.`);
  }
}

buildPool().catch((err) => {
  console.error("[build-pool] fatal error:", err);
  process.exit(1);
});