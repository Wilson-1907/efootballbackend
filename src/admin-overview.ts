import type { Database } from "./lib/db.js";
import { computeStandingsFromMatches } from "./lib/tournament.js";

export function buildAdminOverview(db: Database) {
  const matches = db.matches.map((m) => {
    const home = db.players.find((p) => p.id === m.homeId);
    const away = db.players.find((p) => p.id === m.awayId);
    return {
      ...m,
      home: {
        id: m.homeId,
        name: home?.konamiName || home?.name || "?",
      },
      away: {
        id: m.awayId,
        name: away?.konamiName || away?.name || "?",
      },
    };
  });

  matches.sort((a, b) => {
    const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
    const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.round - b.round;
  });

  const confirmedPlayers = db.players
    .filter((p) => p.status === "confirmed")
    .map((p) => ({ id: p.id, name: p.konamiName || p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const standingsSource = db.matches.some((m) => m.phase === "league")
    ? db.matches.filter((m) => m.phase === "league")
    : db.matches;
  const standings = computeStandingsFromMatches(
    confirmedPlayers,
    standingsSource.map((m) => ({
      status: m.status,
      homeId: m.homeId,
      awayId: m.awayId,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
    })),
  );

  return {
    settings: {
      tournamentName: db.settings.tournamentName,
      registrationStartsAt: db.settings.registrationStartsAt,
      registrationEndsAt: db.settings.registrationEndsAt,
      fixturesGenerated: db.settings.fixturesGenerated,
      tournamentStartsAt: db.settings.tournamentStartsAt,
      tournamentEndsAt: db.settings.tournamentEndsAt,
      matchDurationMinutes: db.settings.matchDurationMinutes,
      breakMinutes: db.settings.breakMinutes,
      rulesMarkdown: db.settings.rulesMarkdown,
      tournamentStopped: db.settings.tournamentStopped,
    },
    players: db.players
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .map((p) => ({ ...p, createdAt: p.createdAt })),
    matches,
    standings,
  };
}
