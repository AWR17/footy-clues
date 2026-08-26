// lib/api-football.js
// Thin wrapper around API-Football (v3.football.api-sports.io).
// Every function here returns raw API data only — no invented values,
// no LLM-generated stats. If the API doesn't have it, we don't show it.

const BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.warn("[api-football] API_FOOTBALL_KEY is not set. Requests will fail.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiGet(path, params = {}, { retries = 3, pauseMs = 6500 } = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY },
    });

    if (res.status === 429) {
      await sleep(pauseMs * (attempt + 1));
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      throw new Error(`API-Football: non-JSON response for ${path} (HTTP ${res.status}). ${parseErr.message}`);
    }

    if (json.errors && Object.keys(json.errors).length > 0) {
      throw new Error(`API-Football error for ${path}: ${JSON.stringify(json.errors)}`);
    }

    return json.response;
  }

  throw new Error(`API-Football: exhausted retries for ${path}`);
}

async function getPlayersForSeason(leagueId, season, page = 1) {
  return apiGet("/players", { league: leagueId, season, page });
}

async function getPlayerTeams(playerId) {
  return apiGet("/players/teams", { player: playerId });
}

async function getPlayerTransfers(playerId) {
  const resp = await apiGet("/transfers", { player: playerId });
  const entry = resp?.[0];
  return (entry?.transfers || []).map((t) => ({
    date: t.date ?? null,
    fee: t.type ?? null,
    clubIn: t.teams?.in?.name ?? null,
    clubOut: t.teams?.out?.name ?? null,
  }));
}

async function getPlayerTrophies(playerId) {
  const resp = await apiGet("/trophies", { player: playerId });
  return (resp || []).map((t) => ({
    league: t.league ?? null,
    country: t.country ?? null,
    season: t.season ?? null,
    place: t.place ?? null,
  }));
}

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

async function getPlayerProfile(playerId, season) {
  const resp = await apiGet("/players", { id: playerId, season });
  const entry = resp?.[0];
  return {
    nationality: entry?.player?.nationality ?? null,
    position: entry?.statistics?.[0]?.games?.position ?? null,
    firstname: entry?.player?.firstname ?? null,
    lastname: entry?.player?.lastname ?? null,
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