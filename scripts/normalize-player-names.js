// scripts/normalize-player-names.js
//
// ONE-TIME migration script. Fixes the display name of every player
// already in data/player-pool.json to a consistent "Firstname Lastname"
// format. Previously the pool stored API-Football's raw player.name field
// as-is, which is inconsistently formatted — e.g. "K. Tierney" for some
// players, "Kieran Richardson" for others — producing a visibly mismatched
// guess-box autocomplete list on the live site.
//
// Run this ONCE, after deploying the build-player-pool.js update in the
// same commit, to fix the players already in the pool. New players added
// by future build-player-pool.js runs are normalized automatically going
// forward — this script does not need to be re-run for those.
//
// Only makes API calls for names that actually look abbreviated, to avoid
// spending calls on the names that are already in the target format
// (roughly a third of the current ~800-player pool). For each one, tries
// several recent seasons (not just the current one) before giving up —
// API-Football only returns a profile for a season the player actually
// has registered stats in, so a single current-season lookup silently
// misses anyone who's retired or winding down. See lib/name-normalize.js
// for why this matters (confirmed in production: the players a
// single-season lookup missed were consistently long-serving veterans,
// not a random sample).
//
// Safe to re-run: it only ever looks up names that still look abbreviated,
// so a second run just picks up whatever the first one couldn't resolve.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/normalize-player-names.js

const fs = require("fs");
const path = require("path");
const { getPlayerProfile, sleep } = require("../lib/api-football");
const { looksAbbreviated, findFullName } = require("../lib/name-normalize");

const POOL_PATH = path.join(__dirname, "../data/player-pool.json");
const PLAYERS_INDEX_PATH = path.join(__dirname, "../public/players-index.json");
const REQUEST_PAUSE_MS = 300;

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function normalizeNames() {
  const pool = loadJSON(POOL_PATH, []);
  if (pool.length === 0) {
    throw new Error(`No player pool found at ${POOL_PATH}. Nothing to normalize.`);
  }

  const toFix = pool.filter((p) => looksAbbreviated(p.name));
  console.log(`[normalize-names] ${toFix.length} of ${pool.length} players look abbreviated and will be looked up (trying multiple seasons each). The rest are left untouched.`);

  let changed = 0;
  let stillUnresolved = 0;
  let processed = 0;

  for (let i = 0; i < pool.length; i++) {
    const player = pool[i];
    if (!looksAbbreviated(player.name)) continue;

    const fullName = await findFullName(player.id, player.name, {
      getPlayerProfile,
      sleep,
      requestPauseMs: REQUEST_PAUSE_MS,
    });

    if (fullName !== player.name) {
      console.log(`[normalize-names] ${player.name} -> ${fullName}`);
      pool[i] = { ...player, name: fullName };
      changed++;
    } else {
      console.warn(`[normalize-names] no usable profile found across the lookback window for ${player.name} (id ${player.id}) — keeping original name.`);
      stillUnresolved++;
    }

    processed++;
    if (processed % 20 === 0) {
      console.log(`[normalize-names] progress: ${processed}/${toFix.length}`);
    }
  }

  saveJSON(POOL_PATH, pool);

  // Keep players-index.json (the guess-box autocomplete source) in sync
  // immediately, rather than waiting for tomorrow's daily job to regenerate
  // it from the pool.
  const index = pool.map((p) => ({ id: p.id, name: p.name }));
  saveJSON(PLAYERS_INDEX_PATH, index);

  console.log(`[normalize-names] done. Changed: ${changed}, still unresolved (kept original): ${stillUnresolved}, already fine: ${pool.length - toFix.length}.`);
}

normalizeNames().catch((err) => {
  console.error("[normalize-names] fatal error:", err);
  process.exit(1);
});
