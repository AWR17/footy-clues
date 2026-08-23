// lib/api-football.js
// Thin wrapper around API-Football (v3.football.api-sports.io).
// Every function here returns raw API data only — no invented values,
// no LLM-generated stats. If the API doesn't have it, we don't show it.

const BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.warn("[api-football] API_FOOTBALL_KEY is not set. Requests will fail.");
}

// Simple sleep helper for pacing requests under rate limits.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Low-level GET against API-Football, with basic retry on 429.
 */
async function apiGet(path, params = {}, { retries = 3, pauseMs = 6500 } = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY },
    });

    if (res.status === 429) {
      // Rate limited — back off and retry.
      await sleep(pauseMs * (attempt + 1));
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      // Not valid JSON at all — e.g. a gateway error page. Give a clear
      // signal rather than letting a cryptic parse error bubble up.
      throw new Error(`API-Football: non-JSON response for ${path} (HTTP ${res.status}). ${parseErr.message}`);
    }

    if (json.errors && Object.keys(json.errors).length > 0) {
      throw new Error(`API-Football error for ${path}: ${JSON.stringify(json.errors)}`);
    }

    return json.response;
  }

  throw new Error(`API-Football: exhausted retries for ${path}`);
}

/**
 * Players active in a given league + season, with their per-season stats.
 * API-Football paginates at 20 players/page for this endpoint.
 */
async function getPlayersForSeason(leagueId, season, page = 1) {
  return apiGet("/players", { league: leagueId, season, page });
}

/**
 * Full list of teams (and the seasons at each) a player has been
 * registered to across their career. This is the backbone of the
 * career-path clue list.
 */
async function getPlayerTeams(playerId) {
  return apiGet("/players/teams", { player: playerId });
}

/**
 * Transfer history for a player — used here specifically to surface the
 * fee for the move that began a given career stint (e.g. "€45M", "Free",
 * "Loan"). Also useful for pinning exact transfer dates when the
 * /players/teams season data alone is ambiguous.
 *
 * NOTE: field names here follow API-Football's documented schema, but
 * schemas do drift — worth double-checking against a live response the
 * first time you run this for real, rather than trusting it blind.
 */
async function getPlayerTransfers(playerId) {
  const resp = await apiGet("/transfers", { player: playerId });
  const entry = resp?.[0];
  return (entry?.transfers || []).map((t) => ({
    date: t.date ?? null,
    fee: t.type ?? null, // a fee string like "€45M", or "Free" / "Loan" / "N/A"
    clubIn: t.teams?.in?.name ?? null,
    clubOut: t.teams?.out?.name ?? null,
  }));
}

/**
 * Team-level trophies/honours (league titles, cup wins) a player picked
 * up across their career — NOT individual awards like Player of the
 * Month, which API-Football doesn't expose as structured data. Included
 * on every plan, including Free.
 */
async function getPlayerTrophies(playerId) {
  const resp = await apiGet("/trophies", { player: playerId });
  return (resp || []).map((t) => ({
    league: t.league ?? null,
    country: t.country ?? null,
    season: t.season ?? null, // typically a string like "2015/2016"
    place: t.place ?? null, // e.g. "Winner", "2nd Place", "Runner-up"
  }));
}

/**
 * Per-season, per-team stats for a specific player (appearances, goals).
 * This is called once per team-stint per season, so it's the most
 * "expensive" call in the pipeline — cache aggressively downstream.
 */
async function getPlayerSeasonStats(playerId, season, teamId) {
  const resp = await apiGet("/players", { id: playerId, season, team: teamId });
  const stat = resp?.[0]?.statistics?.[0];
  return {
    appearances: stat?.games?.appearences ?? 0,
    goals: stat?.goals?.total ?? 0,
    yellowCards: stat?.cards?.yellow ?? 0,
    redCards: stat?.cards?.red ?? 0,
    leagueId: stat?.league?.id ?? null,
    leagueName: stat?.league?.name ?? null,
    country: stat?.league?.country ?? null,
  };
}

/**
 * Fallback for when the team-scoped season query returns nothing usable.
 * Queries the player's stats for that season WITHOUT filtering by team —
 * this returns a `statistics` entry per team/competition they represented
 * that season, so we search it for the one matching our target team and
 * pull league info from there instead. Only worth calling when the
 * primary lookup already failed, since it's a broader, heavier query.
 */
async function getPlayerSeasonAnyTeamLeague(playerId, season, teamId) {
  const resp = await apiGet("/players", { id: playerId, season });
  const entry = resp?.[0];
  const match = entry?.statistics?.find((s) => s.team?.id === teamId);
  return {
    leagueId: match?.league?.id ?? null,
    leagueName: match?.league?.name ?? null,
    country: match?.league?.country ?? null,
  };
}

/**
 * Basic profile info (nationality, primary position) for the hint feature.
 * Cheap, single call — doesn't loop over seasons like career stats do.
 *
 * IMPORTANT: pass a season you know the player was actually active in
 * (e.g. their most recent career stint's year). Querying the current
 * calendar year by default silently returns nothing for any retired or
 * long-inactive player — which, for this game's player pool, is a lot
 * of them — making the hint feature quietly unavailable for exactly the
 * players most likely to need one.
 */
async function getPlayerProfile(playerId, season) {
  const resp = await apiGet("/players", { id: playerId, season });
  const entry = resp?.[0];
  return {
    nationality: entry?.player?.nationality ?? null,
    position: entry?.statistics?.[0]?.games?.position ?? null,
  };
}

module.exports = {
  apiGet,
  sleep,
  getPlayersForSeason,
  getPlayerTeams,
  getPlayerTransfers,
  getPlayerTrophies,
  getPlayerSeasonStats,
  getPlayerSeasonAnyTeamLeague,
  getPlayerProfile,
};
