// lib/league-tiers.js
//
// API-Football identifies leagues by numeric ID. This table maps those
// IDs to a human-readable "tier" label used in hidden-club clues, e.g.
// "a club in the 1st tier, England" instead of naming the club.
//
// Coverage gap to know about: API-Football's data for English non-league
// football (National League and below — tiers 5+) is patchy or absent.
// Players with a Jamie-Vardy-style route through non-league football will
// often have a gap here. MANUAL_STINTS below is the escape hatch: hand-entered
// stints for specific players where the API has nothing, sourced and dated
// by a human so they don't silently go stale or unverified.

const LEAGUE_TIERS = {
  // England
  39: { label: "1st tier, England", short: "Premier League", country: "England" },
  40: { label: "2nd tier, England", short: "EFL Championship", country: "England" },
  41: { label: "3rd tier, England", short: "EFL League One", country: "England" },
  42: { label: "4th tier, England", short: "EFL League Two", country: "England" },
  45: { label: "domestic cup, England", short: "FA Cup", country: "England" },

  // Scotland
  179: { label: "1st tier, Scotland", short: "Scottish Premiership", country: "Scotland" },

  // Spain
  140: { label: "1st tier, Spain", short: "La Liga", country: "Spain" },
  141: { label: "2nd tier, Spain", short: "La Liga 2", country: "Spain" },

  // Italy
  135: { label: "1st tier, Italy", short: "Serie A", country: "Italy" },
  136: { label: "2nd tier, Italy", short: "Serie B", country: "Italy" },

  // Germany
  78: { label: "1st tier, Germany", short: "Bundesliga", country: "Germany" },
  79: { label: "2nd tier, Germany", short: "2. Bundesliga", country: "Germany" },

  // France
  61: { label: "1st tier, France", short: "Ligue 1", country: "France" },
  62: { label: "2nd tier, France", short: "Ligue 2", country: "France" },

  // Netherlands
  88: { label: "1st tier, Netherlands", short: "Eredivisie", country: "Netherlands" },

  // Portugal
  94: { label: "1st tier, Portugal", short: "Primeira Liga", country: "Portugal" },

  // USA
  253: { label: "1st tier, USA", short: "MLS", country: "USA" },

  // International club comps (rarely used as a clue "club", but useful to recognise)
  2: { label: "European competition", short: "UEFA Champions League", country: null },
  3: { label: "European competition", short: "UEFA Europa League", country: null },
};

/**
 * Look up a tier label from an API-Football league ID.
 * Falls back to a generic label if we haven't mapped it yet, so the
 * pipeline never crashes on an unmapped league — it just produces a
 * vaguer clue and gets flagged for review (see scripts/daily-puzzle.js).
 */
function tierFor(leagueId, fallbackCountry) {
  const entry = LEAGUE_TIERS[leagueId];
  if (entry) return entry;
  return {
    label: fallbackCountry ? `a club in ${fallbackCountry}` : "an unspecified league",
    short: null,
    country: fallbackCountry ?? null,
    unmapped: true, // flag for the review step
  };
}

/**
 * Manually curated stints for well-known non-league / lower-tier spells
 * that API-Football doesn't reliably cover. Keyed by player ID (API-Football
 * player ID). Each entry should match the shape the automated pipeline
 * produces — see the fields below — plus a sourceNote so it's clear this
 * one was hand-verified rather than pulled live.
 *
 * Add to this sparingly and only for stints you've personally checked —
 * it's the one place in the pipeline where a wrong number could slip in
 * unnoticed by an automated check.
 *
 * Fields yellowCards/redCards/country can be omitted if unknown — the
 * pipeline treats missing values as 0/null safely — but note that manual
 * stints never get enriched with trophies/transfer-fee data (that only
 * happens for API-sourced stints in attachTrophiesAndTransfers), and a
 * missing `country` will silently prevent trophy-matching too, so it's
 * worth filling in when you know it.
 */
const MANUAL_STINTS = {
  // Example shape — replace with real player IDs as you curate them:
  // 12345: [
  //   {
  //     clubName: "Stocksbridge Park Steels",
  //     country: "England",
  //     tierLabel: "8th tier / non-league, England",
  //     yearStart: 2006,
  //     yearsAtClub: 3,
  //     appearances: 107,
  //     goals: 66,
  //     yellowCards: 0,
  //     redCards: 0,
  //     tierChangeNote: null,
  //     sourceNote: "BBC Sport, verified 2026-08-19",
  //   },
  // ],
};

module.exports = { LEAGUE_TIERS, tierFor, MANUAL_STINTS };
