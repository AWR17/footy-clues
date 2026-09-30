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

// True for names like "K. Tierney" or "J.Smith" — an initial followed by a
// surname, rather than a spelled-out first name.
function looksAbbreviated(name) {
  return ABBREVIATED_NAME_PATTERN.test(name || "");
}

// Builds a "Firstname Lastname" string from an API-Football player profile
// (the shape returned by getPlayerProfile: { firstname, lastname, ... }),
// falling back to the original name if the profile lookup didn't return
// usable firstname/lastname data. Only the first given name is used (e.g.
// profile.firstname "Timothy Matthew" -> "Timothy"), matching the existing
// display-name convention in scripts/daily-puzzle.js.
function buildFullName(profile, fallbackName) {
  const firstFull = profile?.firstname?.trim();
  const last = profile?.lastname?.trim();
  if (!firstFull || !last) return fallbackName;

  const firstGivenName = firstFull.split(/\s+/)[0];
  return `${firstGivenName} ${last}`.trim();
}

module.exports = { looksAbbreviated, buildFullName };