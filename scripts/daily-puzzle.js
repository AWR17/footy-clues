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
const { looksAbbreviated, buildFullName } = require("../lib/name-normalize");

const POOL_PATH = path.join(__dirname, "../data/player-pool.json");
const CACHE_DIR = path.join(__dirname, "../data/career-cache");
const PUZZLES_DIR = path.join(__dirname, "../public/puzzles");
const REVIEW_QUEUE_PATH = path.join(__dirname, "../data/review-queue.json");
const PLAYERS_INDEX_PATH = path.join(__dirname, "../public/players-index.json");

const REQUEST_PAUSE_MS = 300;
const MIN_STINTS_TO_PUBLISH = 3;

// How many candidates findCandidateForToday() will draw and validate before
// giving up. This budget covers TWO different jobs at once:
//   1. Finding any candidate that's actually valid (enough usable stints,
//      no unmapped league tier in the selected clues).
//   2. Within that, preferring one that also matches the day's theme.
// It used to be 5, tuned only with (2) in mind. But (1) alone can eat the
// whole budget on a bad day — lib/league-tiers.js currently only covers a
// dozen top-flight leagues, so a large share of draws get rejected purely
// for an unmapped tier (see data/review-queue.json), independent of theme
// matching. 5 straight rejections isn't rare enough to treat as "should
// never happen", and when it does the job errors out and no puzzle gets
// published at all (2026-09-20 was the first time this actually happened).
// 20 gives (1) much more room before (2) even comes into play, without
// meaningfully slowing the job down (each rejected candidate is normally
// already cached from a previous day's attempt).
const MAX_CANDIDATE_ATTEMPTS = 20;

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
  const match = tierLabel?.match(/(\d+)(?:st|nd|rd|th) tier/i);
  return match ? parseInt(match[1], 10) : null;
}

const YOUTH_RESERVE_PATTERN = /\b(u1[4-9]|u2[0-3]|youth|reserves?|academy|juniors?)\b/i;

const KNOWN_COUNTRY_NAMES = new Set([
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia",
  "Australia", "Austria", "Azerbaijan", "Bahrain", "Bangladesh", "Belarus", "Belgium",
  "Benin", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Bulgaria",
  "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde", "Chad",
  "Chile", "China", "Colombia", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus",
  "Czech Republic", "DR Congo", "Denmark", "Ecuador", "Egypt", "El Salvador",
  "England", "Equatorial Guinea", "Estonia", "Ethiopia", "Fiji", "Finland", "France",
  "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Guatemala", "Guinea",
  "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq",
  "Ireland", "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kosovo", "Kuwait", "Latvia", "Lebanon", "Liberia", "Libya",
  "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Mali", "Malta",
  "Mexico", "Moldova", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria",
  "North Korea", "North Macedonia", "Northern Ireland", "Norway", "Oman", "Pakistan",
  "Panama", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar",
  "Republic of Ireland", "Romania", "Russia", "Rwanda", "Saudi Arabia", "Scotland",
  "Senegal", "Serbia", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Somalia",
  "South Africa", "South Korea", "Spain", "Sri Lanka", "Sudan", "Sweden",
  "Switzerland", "Syria", "Tanzania", "Thailand", "Togo", "Trinidad and Tobago",
  "Tunisia", "Turkey", "Uganda", "Ukraine", "United Arab Emirates", "United States",
  "USA", "Uruguay", "Uzbekistan", "Venezuela", "Vietnam", "Wales", "Zambia", "Zimbabwe",
]);

function isYouthOrReserveTeam(teamName) {
  if (!teamName) return false;
  if (YOUTH_RESERVE_PATTERN.test(teamName)) return true;
  const trimmed = teamName.trim();
  if (/\sII$/.test(trimmed)) return true;
  if (/\sB$/.test(trimmed)) return true;
  return false;
}

function normalizeClubKey(name) {
  if (!name) return "";
  const key = name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .trim();

  const genericTokens = ["afc", "fc", "cf"];
  const words = key.split(/\s+/).filter(Boolean);
  while (words.length > 1 && genericTokens.includes(words[0])) words.shift();
  while (words.length > 1 && genericTokens.includes(words[words.length - 1])) words.pop();

  return words.join(" ");
}

// Loose equality for club names coming from two different API-Football
// endpoints (/players/teams vs /transfers), which don't always spell a
// club the same way ("Hull City" vs "Hull", "Manchester Utd" vs
// "Manchester United"). Exact match after normalizeClubKey(), or one name
// fully containing the other once common abbreviations are expanded,
// counts as the same club. Deliberately permissive — this backs a check
// (below) that REJECTS a candidate, so a missed match (false "they're
// different") is far more costly than an over-eager one (false "they're
// the same").
function expandCommonAbbreviations(key) {
  return key
    .split(" ")
    .map((w) => (w === "utd" ? "united" : w))
    .join(" ");
}

function clubNamesLooselyMatch(a, b) {
  const keyA = expandCommonAbbreviations(normalizeClubKey(a));
  const keyB = expandCommonAbbreviations(normalizeClubKey(b));
  if (!keyA || !keyB) return false;
  return keyA === keyB || keyA.includes(keyB) || keyB.includes(keyA);
}

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

async function getCareerHistory(playerId) {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  const cached = loadJSON(cachePath, null);
  const isValidCache = Array.isArray(cached) && cached.length > 0 &&
    cached.every((s) => typeof s.isNationalTeam === "boolean" && typeof s.tierUnmapped === "boolean");
  if (isValidCache) return cached;

  const teams = await getPlayerTeams(playerId);
  await sleep(REQUEST_PAUSE_MS);

  const stints = [];

  for (const t of teams) {
    const seasons = t.seasons || [];
    if (seasons.length === 0) continue;

    if (isYouthOrReserveTeam(t.team.name)) continue;

    const isNationalTeam = t.team.name === t.team.country || KNOWN_COUNTRY_NAMES.has(t.team.name);

    let totalApps = 0;
    let totalGoals = 0;
    let totalYellows = 0;
    let totalReds = 0;
    const seasonLeagues = [];

    for (const season of seasons) {
      const stat = await getPlayerSeasonStats(playerId, season, t.team.id);
      totalApps += stat.appearances;
      totalGoals += stat.goals;
      totalYellows += stat.yellowCards;
      totalReds += stat.redCards;
      if (stat.leagueId) seasonLeagues.push({ season, leagueId: stat.leagueId });
      await sleep(REQUEST_PAUSE_MS);
    }

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
      tierLabel: tier.label,
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

  const mergedByClub = new Map();
  for (const s of stints) {
    if (s.isNationalTeam) {
      mergedByClub.set(Symbol(s.clubName), s);
      continue;
    }
    const key = normalizeClubKey(s.clubName);
    const existing = mergedByClub.get(key);
    if (!existing) {
      mergedByClub.set(key, { ...s });
      continue;
    }
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

  const { stints: enrichedStints, transfers } = await attachTrophiesAndTransfers(playerId, mergedStints);
  const manual = MANUAL_STINTS[playerId] || [];
  const allStints = [...manual, ...enrichedStints].sort((a, b) => a.yearStart - b.yearStart);

  // Cross-check against transfer history. /players/teams (what the stints
  // above are built from) silently dropped Michael Dawson's first
  // Nottingham Forest spell on 2026-10-01 — it just wasn't in the response,
  // no error, no gap to notice. /transfers is a different, independently
  // sourced endpoint, and it still named the club (and date) each transfer
  // was to/from.
  //
  // This has to be year-aware, not just "is this club name present
  // somewhere in the stints" — Dawson's case is exactly a player who
  // RETURNS to a club they have a later stint for (Forest 2001, then
  // Forest 2018). A name-only check would see "Nottingham Forest" already
  // in the stints list and wave the 2001 gap straight through. So for
  // each transfer, a matching stint has to cover roughly the right years,
  // not just carry the right name.
  const clubStints = allStints.filter((s) => !s.isNationalTeam);
  const stintCoversYear = (stint, clubName, year) =>
    clubNamesLooselyMatch(stint.clubName, clubName) &&
    year >= stint.yearStart - 1 &&
    year <= stint.yearStart + stint.yearsAtClub;

  const missingClubs = [];
  transfers.forEach((t) => {
    if (!t.date) return;
    const transferYear = parseInt(t.date.slice(0, 4), 10);
    if (Number.isNaN(transferYear)) return;

    if (t.clubIn && !clubStints.some((s) => stintCoversYear(s, t.clubIn, transferYear))) {
      missingClubs.push(`${t.clubIn} (joined ~${transferYear})`);
    }
    if (t.clubOut && !clubStints.some((s) => stintCoversYear(s, t.clubOut, transferYear))) {
      missingClubs.push(`${t.clubOut} (left ~${transferYear})`);
    }
  });

  saveJSON(cachePath, allStints);
  if (missingClubs.length > 0) {
    const err = new Error(
      `Transfer history mentions ${missingClubs.join(", ")} but no matching stint was built from /players/teams — likely a missing club (same bug that hid Michael Dawson's first Nottingham Forest spell, 2026-10-01). Check manually; if real, add it to MANUAL_STINTS in lib/league-tiers.js, then delete data/career-cache/${playerId}.json to force a rebuild.`
    );
    err.isMissingClubFlag = true;
    err.missingClubs = missingClubs;
    throw err;
  }
  return allStints;
}

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

  const enriched = stints.map((s) => {
    const stintEndYear = s.yearStart + s.yearsAtClub - 1;

    const wonTrophy = trophies.find((t) => {
      if (t.place !== "Winner") return false;
      const seasonStartYear = parseInt(String(t.season).slice(0, 4), 10);
      if (Number.isNaN(seasonStartYear)) return false;
      return seasonStartYear >= s.yearStart && seasonStartYear <= stintEndYear && t.country === s.country;
    });

    const transferIn = transfers.find((t) => {
      if (!t.date || !t.clubIn) return false;
      const transferYear = parseInt(t.date.slice(0, 4), 10);
      return transferYear === s.yearStart && t.clubIn === s.clubName;
    });

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

  return { stints: enriched, transfers };
}

function selectClueWorthyStints(allStints) {
  const stints = allStints.filter((s) => !s.isNationalTeam);

  if (stints.length <= 5) return stints;

  const first = stints[0];
  const last = stints[stints.length - 1];
  const biggestPL = [...stints]
    .filter((s) => s.tierLabel === "1st tier, England")
    .sort((a, b) => b.appearances - a.appearances)[0];

  const mustInclude = [first, biggestPL, last].filter(Boolean);
  const mustIncludeUnique = [...new Set(mustInclude)];

  const remaining = stints.filter((s) => !mustIncludeUnique.includes(s));
  const slotsNeeded = Math.max(0, 5 - mustIncludeUnique.length);

  const usedClubNames = new Set(mustIncludeUnique.map((s) => s.clubName));
  const noDupPool = remaining.filter((s) => !usedClubNames.has(s.clubName));
  const remainingPool = noDupPool.length >= slotsNeeded ? noDupPool : remaining;

  const spread = [];
  if (slotsNeeded > 0 && remainingPool.length > 0) {
    const step = remainingPool.length / slotsNeeded;
    for (let i = 0; i < slotsNeeded; i++) {
      let idx = Math.min(remainingPool.length - 1, Math.floor(i * step));
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
  const clubDisplay = isFinal ? stint.clubName : null;
  const notable = isNotableDiscipline(stint);
  const noteText = stint.tierChangeNote
    ? (stint.tierChangeNote === "promoted" ? "Promoted during this spell" : "Relegated during this spell")
    : "";
  const extraText = [
    notable ? `${stint.yellowCards} yellow, ${stint.redCards} red` : null,
    stint.honour || null,
    stint.transferFee ? `signed for ${stint.transferFee}` : null,
    noteText || null,
  ].filter(Boolean).join(" · ");

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
    text: `${stint.yearStart} · joined ${isFinal ? stint.clubName : `a club in ${stint.tierLabel}`} · ${stint.yearsAtClub} year(s) there · ${stint.goals} goals in ${stint.appearances} appearances${extraText ? ` · ${extraText}` : ""}`,
  };
}

function flagForReview(entry) {
  const queue = loadJSON(REVIEW_QUEUE_PATH, []);
  queue.push({ ...entry, flaggedAt: new Date().toISOString() });
  saveJSON(REVIEW_QUEUE_PATH, queue);
}

async function findCandidateForToday(pool, date) {
  const dayOfWeek = new Date(date + "T00:00:00Z").getUTCDay();
  const themeConfig = THEME_DAYS[dayOfWeek] || null;

  let fallback = null;
  const rejectedIds = [];
  // Candidates already drawn THIS run (whether rejected, API-failed, or
  // just seen). pickTodaysPlayer's hash-per-suffix scheme doesn't
  // guarantee a different candidate on every attempt — two different
  // suffixes can land on the same index — so without this, the same
  // candidate can get redrawn and re-processed, wasting an attempt slot,
  // an API call, and (for a rejected candidate) a duplicate review-queue
  // entry. Confirmed happening in production on 2026-09-22 (J. Harrison
  // flagged twice, 14 seconds apart, same day).
  const triedIds = new Set();

  for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : `-alt${attempt}`;
    const candidate = pickTodaysPlayer(pool, date, suffix);

    if (triedIds.has(candidate.id)) {
      continue; // same candidate as an earlier attempt this run — skip re-fetching
    }
    triedIds.add(candidate.id);

    let stints;
    try {
      stints = await getCareerHistory(candidate.id);
    } catch (err) {
      if (err.isMissingClubFlag) {
        // getCareerHistory() found a club in /transfers with no matching
        // built stint — the Michael Dawson bug signature (see the comment
        // there). Treat this as a real data-quality rejection, same as
        // too-few-stints or an unmapped tier below: flag it, retire the
        // candidate (rejectedIds -> used: true) so it can't silently slip
        // through once getCareerHistory()'s cache makes this check a
        // no-op on a future draw, and move on to the next candidate.
        flagForReview({
          date,
          playerId: candidate.id,
          playerName: candidate.name,
          reason: err.message,
          clubs: err.missingClubs,
        });
        rejectedIds.push(candidate.id);
        continue;
      }
      // Any other failure (rate limit, timeout, malformed response) used
      // to propagate all the way up and abort the ENTIRE day's job, even
      // with other valid candidates untried in the pool. Treat it like
      // any other "try the next candidate" case — but, unlike a genuine
      // data-quality rejection, do NOT add it to rejectedIds: those get
      // permanently marked `used` in the pool, and a transient network
      // blip isn't a real reason to retire a player from the game forever.
      // It'll simply be eligible to be drawn again another day.
      console.warn(`[daily-puzzle] career history lookup failed for ${candidate.name} (id ${candidate.id}): ${err.message} — skipping this candidate for today.`);
      continue;
    }

    if (stints.length < MIN_STINTS_TO_PUBLISH) {
      flagForReview({
        date,
        playerId: candidate.id,
        playerName: candidate.name,
        reason: `Only ${stints.length} usable stint(s) found — below minimum of ${MIN_STINTS_TO_PUBLISH}.`,
      });
      rejectedIds.push(candidate.id);
      continue;
    }

    const selected = selectClueWorthyStints(stints);
    const unmapped = selected.filter((s) => s.tierUnmapped);
    if (unmapped.length > 0) {
      flagForReview({
        date,
        playerId: candidate.id,
        playerName: candidate.name,
        reason: `${unmapped.length} of the selected clue stint(s) have an unmapped league tier — would show as "unspecified league." Consider adding to lib/league-tiers.js, or this player will keep getting skipped.`,
        clubs: unmapped.map((s) => s.clubName),
      });
      rejectedIds.push(candidate.id);
      continue;
    }

    if (!fallback) fallback = { candidate, stints, selected };

    if (!themeConfig || themeConfig.predicate(stints)) {
      return { candidate, stints, selected, theme: themeConfig ? themeConfig.label : null, rejectedIds };
    }
  }

  if (fallback) {
    console.warn(`[daily-puzzle] no theme match found for ${date} after ${MAX_CANDIDATE_ATTEMPTS} attempts — publishing without a theme.`);
    return { ...fallback, theme: null, rejectedIds };
  }

  throw new Error(`No usable candidate found for ${date} after ${MAX_CANDIDATE_ATTEMPTS} attempts.`);
}

function writePlayersIndex(pool) {
  const index = pool.map((p) => ({ id: p.id, name: p.name }));
  saveJSON(PLAYERS_INDEX_PATH, index);
}

async function run(dateArg) {
  const date = todayISO(dateArg);
  const pool = loadJSON(POOL_PATH, []);
  if (pool.length === 0) {
    throw new Error(`No player pool found at ${POOL_PATH}. Run build-player-pool.js first.`);
  }

  writePlayersIndex(pool);

  const { candidate, stints, selected, theme, rejectedIds } = await findCandidateForToday(pool, date);
  console.log(`[daily-puzzle] ${date}: selected ${candidate.name} (id ${candidate.id})${theme ? ` — ${theme}` : ""}`);
  if (rejectedIds.length > 0) {
    console.log(`[daily-puzzle] also retiring ${rejectedIds.length} candidate(s) rejected for too few stints or an unmapped league in their clues: ${rejectedIds.join(", ")}`);
  }

  const clues = selected.map((s, i) =>
    formatClue(s, i + 1, i === selected.length - 1)
  );

  let hint = null;
  let displayName = candidate.name;
  try {
    const lastKnownSeason = stints[stints.length - 1]?.yearStart ?? new Date().getFullYear();
    const profile = await getPlayerProfile(candidate.id, lastKnownSeason);
    if (profile.nationality || profile.position) hint = profile;

    // Pool names are normalized to "Firstname Lastname" at build time now
    // (see build-player-pool.js / normalize-player-names.js), so this is
    // normally a no-op — kept as a safety net for any straggler entry.
    if (looksAbbreviated(candidate.name)) {
      displayName = buildFullName(profile, candidate.name);
    }
  } catch (err) {
    console.warn(`[daily-puzzle] hint profile lookup failed for ${candidate.name}: ${err.message}`);
  }

  const puzzle = {
    date,
    playerId: candidate.id,
    playerName: displayName,
    difficulty: computeDifficulty(candidate),
    theme,
    hint,
    clues,
    // National-team caps (e.g. "Morocco") are a real entry in the raw
    // career data — getCareerHistory() keeps them (flagged
    // isNationalTeam) because selectClueWorthyStints() needs to exclude
    // them from the clue cards specifically. fullCareerPath is the
    // full-career list shown on the result screen once you've solved it,
    // and a country appearing there next to actual clubs reads as a data
    // bug, not a feature — so it gets the same filter applied here.
    fullCareerPath: stints
      .filter((s) => !s.isNationalTeam)
      .map((s) => ({
        club: s.clubName,
        years: s.yearStart,
        duration: s.yearsAtClub,
        goals: s.goals,
        appearances: s.appearances,
      })),
  };

  saveJSON(path.join(PUZZLES_DIR, `${date}.json`), puzzle);
  saveJSON(path.join(PUZZLES_DIR, "latest.json"), puzzle);

  const usedToday = new Set([candidate.id, ...rejectedIds]);
  const updatedPool = pool.map((p) => (usedToday.has(p.id) ? { ...p, used: true } : p));
  saveJSON(POOL_PATH, updatedPool);

  console.log(`[daily-puzzle] published puzzle for ${date}: ${candidate.name}, ${clues.length} clues, difficulty ${puzzle.difficulty}.`);
}

const dateArg = process.argv[2];
run(dateArg).catch((err) => {
  console.error("[daily-puzzle] fatal error:", err);
  process.exit(1);
});
