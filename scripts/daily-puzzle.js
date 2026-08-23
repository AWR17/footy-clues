// scripts/daily-puzzle.js
//
// THE DAILY JOB. Run once a day (see .github/workflows/daily-puzzle.yml).
// 1. Picks the next unused player from the pool (deterministic by date).
// 2. Fetches their full career history from API-Football.
// 3. Selects 5 clue-worthy stints.
// 4. Formats them into the public puzzle JSON the frontend reads.
// 5. Marks the player used, caches their raw career data, flags anything
//    that needs a human look before it goes live.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/daily-puzzle.js [YYYY-MM-DD]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getPlayerTeams, getPlayerSeasonStats, getPlayerSeasonAnyTeamLeague, getPlayerProfile, getPlayerTransfers, getPlayerTrophies, sleep } = require("../lib/api-football");
const { tierFor, MANUAL_STINTS } = require("../lib/league-tiers");

const POOL_PATH = path.join(__dirname, "../data/player-pool.json");
const CACHE_DIR = path.join(__dirname, "../data/career-cache");
const PUZZLES_DIR = path.join(__dirname, "../public/puzzles");
const REVIEW_QUEUE_PATH = path.join(__dirname, "../data/review-queue.json");
const PLAYERS_INDEX_PATH = path.join(__dirname, "../public/players-index.json");

// See scripts/build-player-pool.js for the per-tier rate-limit reasoning.
// 300ms is tuned for API-Football Pro (300 req/min); drop to ~6500ms if
// you're still on the Free plan (10 req/min).
const REQUEST_PAUSE_MS = 300;
const MIN_STINTS_TO_PUBLISH = 3; // below this, flag for manual review instead
const MAX_THEME_ATTEMPTS = 5; // how many candidates to try before giving up on the theme match

// Weekday themes, keyed by UTC day-of-week (0 = Sunday ... 6 = Saturday).
// Each predicate runs against a candidate's already-fetched stint list —
// themes can only be *preferred*, not guaranteed, since we don't know a
// player's career shape until after fetching it.
const THEME_DAYS = {
  1: {
    label: "Non-League Route Monday",
    predicate: (stints) => stints.some((s) => /non-league|tier [5-9]/i.test(s.tierLabel)),
  },
  5: {
    label: "Foreign Import Friday",
    predicate: (stints) => stints.length > 0 && stints[0].country && stints[0].country !== "England",
  },
};

function computeDifficulty(candidate) {
  if (candidate.totalPlApps >= 300) return "easy";
  if (candidate.totalPlApps >= 150) return "medium";
  return "hard";
}

function tierRank(tierLabel) {
  // Extracts the numeric tier from labels like "1st tier, England" or
  // "8th tier / non-league, England" so we can compare levels numerically.
  const match = tierLabel?.match(/(\d+)(?:st|nd|rd|th) tier/i);
  return match ? parseInt(match[1], 10) : null;
}

// Youth/reserve squads API-Football sometimes tracks as their own "team"
// (e.g. "Bayern Munich II", "Chelsea U21", "Barcelona B"). These aren't
// part of a senior career story, so they're filtered out entirely rather
// than treated as a real stint or merged into the senior club's record.
const YOUTH_RESERVE_PATTERN = /\b(u1[4-9]|u2[0-3]|youth|reserves?|academy|juniors?)\b/i;
function isYouthOrReserveTeam(teamName) {
  if (!teamName) return false;
  if (YOUTH_RESERVE_PATTERN.test(teamName)) return true;
  const trimmed = teamName.trim();
  if (/\sII$/.test(trimmed)) return true; // e.g. "Bayern Munich II"
  if (/\sB$/.test(trimmed)) return true; // e.g. "Barcelona B"
  return false;
}

// Normalizes a club name for MATCHING purposes only (never for display) —
// strips accents, punctuation, and a small set of common interchangeable
// prefix/suffix tokens (e.g. "AFC Bournemouth" vs "Bournemouth") so the
// same real club merges correctly even when different API records name
// it slightly differently. Deliberately conservative: doesn't strip
// tokens like "AC" or "SC" that often form a genuine, non-interchangeable
// part of a club's actual name (e.g. "AC Milan").
function normalizeClubKey(name) {
  if (!name) return "";
  const key = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[.]/g, "")
    .trim();

  const genericTokens = ["afc", "fc", "cf"];
  const words = key.split(/\s+/).filter(Boolean);
  while (words.length > 1 && genericTokens.includes(words[0])) words.shift();
  while (words.length > 1 && genericTokens.includes(words[words.length - 1])) words.pop();

  return words.join(" ");
}

// ---------- helpers ----------

function todayISO(argDate) {
  return argDate || new Date().toISOString().slice(0, 10);
}

function hashDateToInt(dateStr) {
  const hash = crypto.createHash("md5").update(dateStr).digest("hex");
  return parseInt(hash.slice(0, 8), 16);
}

function pickTodaysPlayer(pool, dateStr, attemptSuffix = "") {
  const unused = pool.filter((p) => !p.used);
  if (unused.length === 0) {
    throw new Error("Player pool exhausted — run build-player-pool.js again to top it up.");
  }
  const index = hashDateToInt(dateStr + attemptSuffix) % unused.length;
  return unused[index];
}

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------- career fetch (cached — a player's history is fetched once, ever) ----------

async function getCareerHistory(playerId) {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  const cached = loadJSON(cachePath, null);
  if (cached) return cached;

  const teams = await getPlayerTeams(playerId);
  await sleep(REQUEST_PAUSE_MS);

  const stints = [];

  for (const t of teams) {
    const seasons = t.seasons || [];
    if (seasons.length === 0) continue;

    // Skip youth/reserve squads entirely — not a real senior stint, and
    // unlike national caps, not an interesting bonus detail either.
    if (isYouthOrReserveTeam(t.team.name)) continue;

    // API-Football's /players/teams also returns international caps
    // (e.g. "England") alongside real club history, since it treats a
    // national team as just another "team." A domestic tier doesn't
    // apply to that, so it's flagged here rather than tiered — kept in
    // the data (so it still shows as a nice bonus detail in the final
    // full-career-path reveal) but excluded from clue selection in
    // selectClueWorthyStints, where a "tier" is meaningless. National
    // teams reliably have their name match their country (e.g. team.name
    // "England", team.country "England"), which real clubs essentially
    // never do.
    const isNationalTeam = t.team.name === t.team.country;

    let totalApps = 0;
    let totalGoals = 0;
    let totalYellows = 0;
    let totalReds = 0;
    const seasonLeagues = []; // { season, leagueId } — used to detect tier changes within this stint

    for (const season of seasons) {
      const stat = await getPlayerSeasonStats(playerId, season, t.team.id);
      totalApps += stat.appearances;
      totalGoals += stat.goals;
      totalYellows += stat.yellowCards;
      totalReds += stat.redCards;
      if (stat.leagueId) seasonLeagues.push({ season, leagueId: stat.leagueId });
      await sleep(REQUEST_PAUSE_MS);
    }

    // Fallback: if the team-scoped query never found a league for ANY
    // season in this stint (common for marginal/low-appearance spells,
    // where the API's team-filtered response comes back thin), try one
    // broader, non-team-scoped query on the stint's first season instead.
    // Costs one extra call, but only for stints that would otherwise show
    // the vaguest possible "unspecified league" text.
    let fallbackCountry = null;
    if (!isNationalTeam && seasonLeagues.length === 0 && seasons.length > 0) {
      try {
        const fallback = await getPlayerSeasonAnyTeamLeague(playerId, Math.min(...seasons), t.team.id);
        await sleep(REQUEST_PAUSE_MS);
        if (fallback.leagueId) seasonLeagues.push({ season: Math.min(...seasons), leagueId: fallback.leagueId });
        fallbackCountry = fallback.country;
      } catch (err) {
        console.warn(`[daily-puzzle] fallback league lookup failed for ${t.team.name}: ${err.message}`);
      }
    }

    // Determine first/last by season number, not API response order, since
    // the /players/teams seasons array isn't guaranteed to arrive sorted.
    seasonLeagues.sort((a, b) => a.season - b.season);
    const firstLeagueId = seasonLeagues[0]?.leagueId ?? null;
    const lastLeagueId = seasonLeagues[seasonLeagues.length - 1]?.leagueId ?? null;
    const effectiveCountry = t.team.country || fallbackCountry;

    const tier = isNationalTeam
      ? { label: "national team", unmapped: false }
      : tierFor(firstLeagueId, effectiveCountry);
    const lastTier = isNationalTeam
      ? { label: "national team", unmapped: false }
      : tierFor(lastLeagueId, effectiveCountry);
    const firstRank = tierRank(tier.label);
    const lastRank = tierRank(lastTier.label);

    let tierChangeNote = null;
    if (firstRank !== null && lastRank !== null && firstRank !== lastRank) {
      tierChangeNote = lastRank < firstRank ? "promoted" : "relegated";
    }

    stints.push({
      clubName: t.team.name,
      country: effectiveCountry,
      isNationalTeam,
      tierLabel: tier.label, // describes the level they joined at, not necessarily where they ended up
      tierUnmapped: Boolean(tier.unmapped),
      tierChangeNote,
      yearStart: Math.min(...seasons),
      yearsAtClub: seasons.length,
      appearances: totalApps,
      goals: totalGoals,
      yellowCards: totalYellows,
      redCards: totalReds,
    });
  }

  // API-Football sometimes returns the same real-world club as multiple
  // separate team entries — e.g. one per competition registration, or
  // under slightly different name variants (e.g. "AFC Bournemouth" vs
  // "Bournemouth") — rather than one unified spell. Left unmerged, that
  // produces several near-identical "clues" for the same club instead
  // of one accurate one. Merge any stints resolving to the same
  // normalized club name (and not flagged as a national team) into a
  // single combined entry before anything else sees them.
  const mergedByClub = new Map();
  for (const s of stints) {
    if (s.isNationalTeam) {
      mergedByClub.set(Symbol(s.clubName), s); // never merge national team entries into a club
      continue;
    }
    const key = normalizeClubKey(s.clubName);
    const existing = mergedByClub.get(key);
    if (!existing) {
      mergedByClub.set(key, { ...s });
      continue;
    }
    // Combine into the existing entry: earliest start year, summed
    // totals, and keep whichever tier label AND display name came from
    // the stint with more appearances (the more representative of the
    // two — the display name matters here since the two variants may be
    // spelled differently, e.g. "AFC Bournemouth" vs "Bournemouth").
    const combinedAppearances = existing.appearances + s.appearances;
    const moreRepresentative = s.appearances > existing.appearances ? s : existing;
    mergedByClub.set(key, {
      ...existing,
      clubName: moreRepresentative.clubName,
      country: existing.country || s.country,
      tierLabel: moreRepresentative.tierLabel,
      tierUnmapped: moreRepresentative.tierUnmapped,
      tierChangeNote: existing.tierChangeNote || s.tierChangeNote,
      yearStart: Math.min(existing.yearStart, s.yearStart),
      yearsAtClub: Math.max(existing.yearsAtClub, s.yearsAtClub),
      appearances: combinedAppearances,
      goals: existing.goals + s.goals,
      yellowCards: existing.yellowCards + s.yellowCards,
      redCards: existing.redCards + s.redCards,
    });
  }
  const mergedStints = [...mergedByClub.values()];

  // Enrich with trophies/transfer-fee context, then splice in any
  // hand-curated stints (e.g. non-league spells the API misses).
  const enrichedStints = await attachTrophiesAndTransfers(playerId, mergedStints);
  const manual = MANUAL_STINTS[playerId] || [];
  const allStints = [...manual, ...enrichedStints].sort((a, b) => a.yearStart - b.yearStart);

  saveJSON(cachePath, allStints);
  return allStints;
}

// Matches trophies/transfer fees back onto the stint they belong to. Both
// endpoints cover a player's whole career in one call, so this runs once
// per player rather than once per stint.
async function attachTrophiesAndTransfers(playerId, stints) {
  let trophies = [];
  let transfers = [];

  try {
    trophies = await getPlayerTrophies(playerId);
    await sleep(REQUEST_PAUSE_MS);
  } catch (err) {
    console.warn(`[daily-puzzle] trophies lookup failed for player ${playerId}: ${err.message}`);
  }

  try {
    transfers = await getPlayerTransfers(playerId);
    await sleep(REQUEST_PAUSE_MS);
  } catch (err) {
    console.warn(`[daily-puzzle] transfers lookup failed for player ${playerId}: ${err.message}`);
  }

  return stints.map((s) => {
    const stintEndYear = s.yearStart + s.yearsAtClub - 1;

    // Only surfacing outright wins, not runner-up finishes, to keep this a
    // clean positive signal. Matched by season year + country, since the
    // trophies endpoint doesn't return which club it was won with.
    const wonTrophy = trophies.find((t) => {
      if (t.place !== "Winner") return false;
      const seasonStartYear = parseInt(String(t.season).slice(0, 4), 10);
      if (Number.isNaN(seasonStartYear)) return false;
      return seasonStartYear >= s.yearStart && seasonStartYear <= stintEndYear && t.country === s.country;
    });

    // Matched by the year the stint started + the incoming club name,
    // both of which the transfers endpoint does provide directly.
    const transferIn = transfers.find((t) => {
      if (!t.date || !t.clubIn) return false;
      const transferYear = parseInt(t.date.slice(0, 4), 10);
      return transferYear === s.yearStart && t.clubIn === s.clubName;
    });

    // API-Football's transfer "type" field is sometimes a real fee
    // ("€45M"), sometimes a meaningful category ("Free", "Loan") — but
    // occasionally just the generic word "Transfer" or "N/A", which adds
    // no information and reads oddly as "signed for Transfer". Only keep
    // it if it's genuinely informative.
    const genericFeeValues = ["transfer", "n/a"];
    const rawFee = transferIn?.fee || null;
    const meaningfulFee = rawFee && !genericFeeValues.includes(rawFee.trim().toLowerCase())
      ? rawFee
      : null;

    return {
      ...s,
      honour: wonTrophy ? `${wonTrophy.league} winner` : null,
      transferFee: meaningfulFee,
    };
  });
}

// ---------- clue selection ----------

function selectClueWorthyStints(allStints) {
  // National-team caps (flagged in getCareerHistory) stay in the data for
  // the full-career-path reveal, but a "tier" concept doesn't apply to
  // them, so they're never eligible to become one of the 5 clues.
  const stints = allStints.filter((s) => !s.isNationalTeam);

  if (stints.length <= 5) return stints;

  const first = stints[0];
  const last = stints[stints.length - 1];
  const biggestPL = [...stints]
    .filter((s) => s.tierLabel === "1st tier, England")
    .sort((a, b) => b.appearances - a.appearances)[0];

  const mustInclude = [first, biggestPL, last].filter(Boolean);
  // De-dupe in case first/last/biggestPL overlap (e.g. only one club, or PL club is also last)
  const mustIncludeUnique = [...new Set(mustInclude)];

  const remaining = stints.filter((s) => !mustIncludeUnique.includes(s));
  const slotsNeeded = Math.max(0, 5 - mustIncludeUnique.length);

  // Prefer variety: avoid picking a second stint at a club already covered
  // by a must-include slot (e.g. a player who left and later rejoined the
  // same club). If avoiding duplicates would leave too few candidates to
  // fill the remaining slots, fall back to allowing them — a genuine
  // multi-spell story is better than an incomplete clue set.
  const usedClubNames = new Set(mustIncludeUnique.map((s) => s.clubName));
  const noDupPool = remaining.filter((s) => !usedClubNames.has(s.clubName));
  const remainingPool = noDupPool.length >= slotsNeeded ? noDupPool : remaining;

  // Spread remaining picks evenly across the career timeline, still
  // preferring not to repeat a club name across the spread picks themselves
  const spread = [];
  if (slotsNeeded > 0 && remainingPool.length > 0) {
    const step = remainingPool.length / slotsNeeded;
    for (let i = 0; i < slotsNeeded; i++) {
      let idx = Math.min(remainingPool.length - 1, Math.floor(i * step));
      // Nudge forward if this candidate would repeat a club name already chosen
      let attempts = 0;
      while (
        attempts < remainingPool.length &&
        (spread.includes(remainingPool[idx]) || usedClubNames.has(remainingPool[idx].clubName))
      ) {
        idx = (idx + 1) % remainingPool.length;
        attempts++;
      }
      if (!spread.includes(remainingPool[idx])) {
        spread.push(remainingPool[idx]);
        usedClubNames.add(remainingPool[idx].clubName);
      }
    }
  }

  return [...mustIncludeUnique, ...spread].sort((a, b) => a.yearStart - b.yearStart).slice(0, 5);
}

function isNotableDiscipline(stint) {
  if (stint.redCards > 0) return true;
  if (stint.yellowCards >= 10) return true;
  if (stint.appearances > 0 && stint.yellowCards / stint.appearances >= 0.15) return true;
  return false;
}

function formatClue(stint, order, isFinal) {
  const clubDisplay = isFinal ? stint.clubName : null; // null = redacted in the UI
  const notable = isNotableDiscipline(stint);
  const noteText = stint.tierChangeNote
    ? (stint.tierChangeNote === "promoted" ? "Promoted during this spell" : "Relegated during this spell")
    : "";
  const extraText = [
    notable ? `${stint.yellowCards} yellow, ${stint.redCards} red` : null,
    stint.honour || null,
    stint.transferFee ? `signed for ${stint.transferFee}` : null,
    noteText || null,
  ].filter(Boolean).join(" \u00b7 ");

  return {
    order,
    points: [100, 80, 60, 40, 20][order - 1],
    year: stint.yearStart,
    club: clubDisplay,
    league: stint.tierLabel,
    duration: stint.yearsAtClub,
    goals: stint.goals,
    appearances: stint.appearances,
    discipline: notable
      ? { yellow: stint.yellowCards, red: stint.redCards }
      : null,
    honour: stint.honour || null,
    transferFee: stint.transferFee || null,
    note: stint.tierChangeNote || null,
    // Plain-text fallback used for accessibility and any non-visual context
    text: `${stint.yearStart} \u00b7 joined ${isFinal ? stint.clubName : `a club in ${stint.tierLabel}`} \u00b7 ${stint.yearsAtClub} year(s) there \u00b7 ${stint.goals} goals in ${stint.appearances} appearances${extraText ? ` \u00b7 ${extraText}` : ""}`,
  };
}

// ---------- review queue (for anything that shouldn't auto-publish) ----------

function flagForReview(entry) {
  const queue = loadJSON(REVIEW_QUEUE_PATH, []);
  queue.push({ ...entry, flaggedAt: new Date().toISOString() });
  saveJSON(REVIEW_QUEUE_PATH, queue);
}

// ---------- main ----------

async function findCandidateForToday(pool, date) {
  const dayOfWeek = new Date(date + "T00:00:00Z").getUTCDay();
  const themeConfig = THEME_DAYS[dayOfWeek] || null;

  let fallback = null; // best candidate found so far, used if no theme match turns up
  const rejectedIds = []; // too-few-stints candidates — caller should mark these used

  for (let attempt = 0; attempt < MAX_THEME_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : `-alt${attempt}`;
    const candidate = pickTodaysPlayer(pool, date, suffix);
    const stints = await getCareerHistory(candidate.id);

    if (stints.length < MIN_STINTS_TO_PUBLISH) {
      flagForReview({
        date,
        playerId: candidate.id,
        playerName: candidate.name,
        reason: `Only ${stints.length} usable stint(s) found — below minimum of ${MIN_STINTS_TO_PUBLISH}.`,
      });
      rejectedIds.push(candidate.id);
      continue; // try the next candidate, don't mark this one used yet
    }

    if (!fallback) fallback = { candidate, stints };

    if (!themeConfig || themeConfig.predicate(stints)) {
      return { candidate, stints, theme: themeConfig ? themeConfig.label : null, rejectedIds };
    }
  }

  // No theme match found within the attempt budget — publish the first
  // usable candidate anyway, just without a theme label for the day.
  if (fallback) {
    console.warn(`[daily-puzzle] no theme match found for ${date} after ${MAX_THEME_ATTEMPTS} attempts — publishing without a theme.`);
    return { ...fallback, theme: null, rejectedIds };
  }

  throw new Error(`No usable candidate found for ${date} after ${MAX_THEME_ATTEMPTS} attempts.`);
}

function writePlayersIndex(pool) {
  // Lightweight name list for frontend autocomplete — id + name only.
  const index = pool.map((p) => ({ id: p.id, name: p.name }));
  saveJSON(PLAYERS_INDEX_PATH, index);
}

async function run(dateArg) {
  const date = todayISO(dateArg);
  const pool = loadJSON(POOL_PATH, []);
  if (pool.length === 0) {
    throw new Error(`No player pool found at ${POOL_PATH}. Run build-player-pool.js first.`);
  }

  writePlayersIndex(pool); // keep autocomplete data fresh regardless of today's pick

  const { candidate, stints, theme, rejectedIds } = await findCandidateForToday(pool, date);
  console.log(`[daily-puzzle] ${date}: selected ${candidate.name} (id ${candidate.id})${theme ? ` — ${theme}` : ""}`);
  if (rejectedIds.length > 0) {
    console.log(`[daily-puzzle] also retiring ${rejectedIds.length} candidate(s) rejected for too few stints: ${rejectedIds.join(", ")}`);
  }

  const unmapped = stints.filter((s) => s.tierUnmapped);
  if (unmapped.length > 0) {
    flagForReview({
      date,
      playerId: candidate.id,
      playerName: candidate.name,
      reason: `${unmapped.length} stint(s) have an unmapped league tier — clue text will be vague. Consider adding to lib/league-tiers.js.`,
      clubs: unmapped.map((s) => s.clubName),
    });
    // Not a blocker — still publish, just flagged for a later look.
  }

  const selected = selectClueWorthyStints(stints);
  const clues = selected.map((s, i) =>
    formatClue(s, i + 1, i === selected.length - 1)
  );

  let hint = null;
  try {
    // Use the player's own most recent career year, not the current
    // calendar year — querying a season they were never active in
    // silently returns nothing, which would break hints for anyone
    // retired or long out of the game (see lib/api-football.js).
    const lastKnownSeason = stints[stints.length - 1]?.yearStart ?? new Date().getFullYear();
    const profile = await getPlayerProfile(candidate.id, lastKnownSeason);
    if (profile.nationality || profile.position) hint = profile;
  } catch (err) {
    console.warn(`[daily-puzzle] hint profile lookup failed for ${candidate.name}: ${err.message}`);
    // Non-fatal — hint button just won't be available today.
  }

  const puzzle = {
    date,
    playerId: candidate.id,
    playerName: candidate.name,
    difficulty: computeDifficulty(candidate),
    theme,
    hint,
    clues,
    fullCareerPath: stints.map((s) => ({
      club: s.clubName,
      years: s.yearStart,
      duration: s.yearsAtClub,
      goals: s.goals,
      appearances: s.appearances,
    })),
  };

  saveJSON(path.join(PUZZLES_DIR, `${date}.json`), puzzle);
  saveJSON(path.join(PUZZLES_DIR, "latest.json"), puzzle);

  // Mark today's player used, plus anyone rejected along the way for too
  // few stints — they'll stay skipped until manually reconsidered (e.g.
  // after adding MANUAL_STINTS data for them and flipping `used` back to
  // false by hand in data/player-pool.json).
  const usedToday = new Set([candidate.id, ...rejectedIds]);
  const updatedPool = pool.map((p) => (usedToday.has(p.id) ? { ...p, used: true } : p));
  saveJSON(POOL_PATH, updatedPool);

  console.log(`[daily-puzzle] published puzzle for ${date}: ${candidate.name}, ${clues.length} clues, difficulty ${puzzle.difficulty}.`);
}

const dateArg = process.argv[2]; // optional: node daily-puzzle.js 2026-08-20
run(dateArg).catch((err) => {
  console.error("[daily-puzzle] fatal error:", err);
  process.exit(1);
});
