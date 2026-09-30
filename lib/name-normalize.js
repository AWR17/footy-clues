// lib/name-normalize.js
//
// Shared name-formatting helpers. API-Football's raw player.name field is
// inconsistently formatted across players — some come back as an initial
// plus surname ("K. Tierney"), others as a full first name ("Kieran
// Richardson"). Left as-is, this produces a visibly inconsistent guess-box
// autocomplete list (public/players-index.json, sourced from
// data/player-pool.json) — e.g. "K. Tierney" sitting next to "Kieran
// Richardson" in the same dropdown.
//
// The standard going forward is "Firstname Lastname" everywhere, using only
// the player's first given name (not a full middle-name string) — matching
// the convention scripts/daily-puzzle.js already used for expanding the
// day's featured player's display name before this file existed.
//
// Used by:
//   - scripts/build-player-pool.js (normalizes newly-added pool entries)
//   - scripts/normalize-player-names.js (one-time fix for existing entries)
//   - scripts/daily-puzzle.js (expands the day's featured player's display name)

const ABBREVIATED_NAME_PATTERN = /^[A-Z]\.\s?[A-Z]/;

// How many seasons back findFullName() will try before giving up. Needed
// because API-Football's /players endpoint only returns a profile for a
// season the player actually has registered stats in — querying only the
// CURRENT season silently returns nothing for anyone who's retired or
// winding down (confirmed in production: every one of the ~284 players
// normalize-player-names.js couldn't fix on 2026-09-30 was a long-serving
// veteran — Milner, Barry, A. Young, Terry, etc. — not a random sample).
const MAX_SEASON_LOOKBACK = 10;

// True for names like "K. Tierney" or "J.Smith" — an initial followed by a
// surname, rather than a spelled-out first name.
function looksAbbreviated(name) {
  return ABBREVIATED_NAME_PATTERN.test(name || "");
}

// Extracts a "Firstname Lastname" string from a single API-Football player
// profile (the shape returned by getPlayerProfile: { firstname, lastname,
// ... }), or null if that profile didn't have usable data. Only the first
// given name is used (e.g. profile.firstname "Timothy Matthew" ->
// "Timothy"), matching the existing display-name convention in
// scripts/daily-puzzle.js.
function extractFullName(profile) {
  const firstFull = profile?.firstname?.trim();
  const last = profile?.lastname?.trim();
  if (!firstFull || !last) return null;

  const firstGivenName = firstFull.split(/\s+/)[0];
  return `${firstGivenName} ${last}`.trim();
}

// Same as extractFullName, but falls back to the original name instead of
// null when a SINGLE profile lookup has nothing usable. Kept for callers
// that already have a profile in hand from one specific (season-appropriate)
// lookup, e.g. daily-puzzle.js's hint lookup, which already queries the
// player's own last known season rather than the current one.
function buildFullName(profile, fallbackName) {
  return extractFullName(profile) ?? fallbackName;
}

// Looks up a player's profile across several recent seasons (starting at
// `startSeason`, defaulting to the current year, and walking backwards),
// returning the first usable "Firstname Lastname" found. Falls back to
// `fallbackName` if nothing usable turns up within MAX_SEASON_LOOKBACK
// seasons (e.g. a player who retired long enough ago that even the
// lookback window misses them).
//
// Use this instead of a single buildFullName(profile, fallback) call
// whenever the caller doesn't already know a season the player was
// actually active in (build-player-pool.js and normalize-player-names.js
// only have id/name/totalPlApps to go on, not career history).
async function findFullName(id, fallbackName, { getPlayerProfile, sleep, requestPauseMs = 300, startSeason } = {}) {
  const firstSeason = startSeason ?? new Date().getFullYear();

  for (let i = 0; i < MAX_SEASON_LOOKBACK; i++) {
    const season = firstSeason - i;
    let fullName = null;

    try {
      const profile = await getPlayerProfile(id, season);
      fullName = extractFullName(profile);
    } catch (err) {
      // Lookup failed for this season specifically — try an earlier one
      // rather than giving up immediately.
    }

    if (sleep) await sleep(requestPauseMs);
    if (fullName) return fullName;
  }

  return fallbackName;
}

module.exports = { looksAbbreviated, buildFullName, findFullName };
