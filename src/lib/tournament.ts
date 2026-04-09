import {
  createId,
  readDb,
  writeDb,
  type MatchRecord,
  type PlayerRecord,
} from "./db.js";

export type StandingsRow = {
  rank: number;
  playerId: string;
  playerName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
};

function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  // Prefer crypto for better randomness (Node 19+ has global crypto).
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0]! % maxExclusive;
  } catch {
    return Math.floor(Math.random() * maxExclusive);
  }
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

type Pairing = { homeId: string; awayId: string; round: number };

/**
 * Randomized, fair round-robin (single leg).
 * - Everyone plays everyone once.
 * - Home/away is balanced so each player's home count differs by at most 1.
 */
function generateFairRoundRobin(idsInput: string[]): Pairing[] {
  const ids = idsInput.slice();
  shuffleInPlace(ids); // "very random" seed

  const teams: (string | null)[] = ids.slice();
  if (teams.length % 2 === 1) teams.push(null); // bye if odd

  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;

  const out: Pairing[] = [];

  for (let round = 1; round <= rounds; round++) {
    const pairs: Pairing[] = [];

    for (let i = 0; i < half; i++) {
      const a = teams[i]!;
      const b = teams[n - 1 - i]!;
      if (!a || !b) continue;

      // Standard circle method with a home/away pattern that balances across rounds.
      let home = a;
      let away = b;

      const flip =
        i === 0
          ? round % 2 === 0
          : (round + i) % 2 === 0;

      if (flip) {
        home = b;
        away = a;
      }

      pairs.push({ homeId: home, awayId: away, round });
    }

    // Extra randomness: shuffle match order within the round.
    shuffleInPlace(pairs);
    out.push(...pairs);

    // Rotate teams (keep first fixed)
    // [0,1,2,3,4,5] -> [0,5,1,2,3,4]
    const fixed = teams[0]!;
    const rest = teams.slice(1);
    const last = rest.pop()!;
    teams.splice(0, teams.length, fixed, last, ...rest);
  }

  // Final balancing pass: if any player has a home/away imbalance > 1, swap some fixtures.
  const homeCount = new Map<string, number>();
  const awayCount = new Map<string, number>();
  for (const id of idsInput) {
    homeCount.set(id, 0);
    awayCount.set(id, 0);
  }
  for (const m of out) {
    homeCount.set(m.homeId, (homeCount.get(m.homeId) ?? 0) + 1);
    awayCount.set(m.awayId, (awayCount.get(m.awayId) ?? 0) + 1);
  }

  const diff = (id: string) => (homeCount.get(id) ?? 0) - (awayCount.get(id) ?? 0);

  // Try a bounded number of swaps to reduce worst imbalance.
  for (let iter = 0; iter < out.length * 2; iter++) {
    let worstId: string | null = null;
    let worstAbs = 0;
    for (const id of idsInput) {
      const d = Math.abs(diff(id));
      if (d > worstAbs) {
        worstAbs = d;
        worstId = id;
      }
    }
    if (!worstId || worstAbs <= 1) break;

    // Find a match where swapping home/away improves the worst player without hurting others badly.
    const idx = randInt(out.length);
    const m = out[idx]!;
    const before = worstAbs;

    // simulate swap
    const h = m.homeId;
    const a = m.awayId;
    const idsToCheck = [h, a];
    const pre = idsToCheck.map((id) => Math.abs(diff(id)));

    // apply swap counts
    homeCount.set(h, (homeCount.get(h) ?? 0) - 1);
    awayCount.set(h, (awayCount.get(h) ?? 0) + 1);
    homeCount.set(a, (homeCount.get(a) ?? 0) + 1);
    awayCount.set(a, (awayCount.get(a) ?? 0) - 1);

    const post = idsToCheck.map((id) => Math.abs(diff(id)));
    const afterWorst = Math.abs(diff(worstId));

    const ok =
      afterWorst < before &&
      post[0]! <= Math.max(pre[0]!, 1) + 1 &&
      post[1]! <= Math.max(pre[1]!, 1) + 1;

    if (ok) {
      out[idx] = { ...m, homeId: a, awayId: h };
    } else {
      // revert
      homeCount.set(h, (homeCount.get(h) ?? 0) + 1);
      awayCount.set(h, (awayCount.get(h) ?? 0) - 1);
      homeCount.set(a, (homeCount.get(a) ?? 0) - 1);
      awayCount.set(a, (awayCount.get(a) ?? 0) + 1);
    }
  }

  return out;
}

export function ensureFixturesGenerated(db: DatabaseLike): {
  db: DatabaseLike;
  changed: boolean;
} {
  const now = new Date();
  if (db.settings.tournamentStopped) {
    return { db, changed: false };
  }

  const ends = new Date(db.settings.registrationEndsAt);
  /** Pairing/matches only after registration end time (inclusive). */
  const registrationClosed =
    !Number.isNaN(ends.getTime()) && now.getTime() >= ends.getTime();

  const confirmed = db.players
    .filter((p) => p.status === "confirmed")
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  const ids = confirmed.map((p) => p.id);

  let working = db;
  let changed = false;

  if (!registrationClosed) {
    /** Do not match players or touch fixtures until registration is closed. */
    return { db: working, changed };
  }

  /**
   * Older builds set fixturesGenerated=true when the deadline passed but fewer
   * than two players were confirmed, which blocked real pairings after a second
   * player was confirmed. Clear the flag so we can generate matches now.
   */
  if (
    working.settings.fixturesGenerated &&
    working.matches.length === 0 &&
    ids.length >= 2
  ) {
    working = {
      ...working,
      settings: { ...working.settings, fixturesGenerated: false },
    };
    changed = true;
  }

  if (working.settings.fixturesGenerated) {
    return { db: working, changed };
  }

  if (ids.length < 2) {
    /** Registration closed: wait until at least two confirmed players before drawing. */
    return { db: working, changed };
  }

  const pairs = generateFairRoundRobin(ids);
  const matchMinutes = Math.max(10, db.settings.matchDurationMinutes ?? 90);
  const breakMinutes = Math.max(0, db.settings.breakMinutes ?? 15);
  const slotMs = (matchMinutes + breakMinutes) * 60 * 1000;

  const tournamentStart = new Date(db.settings.tournamentStartsAt);
  const tournamentEnd = new Date(db.settings.tournamentEndsAt);
  const canSchedule =
    !Number.isNaN(tournamentStart.getTime()) &&
    !Number.isNaN(tournamentEnd.getTime()) &&
    tournamentEnd.getTime() > tournamentStart.getTime() &&
    slotMs > 0;

  const matches: MatchRecord[] = pairs.map((p, idx) => {
    const scheduledAt =
      canSchedule && tournamentStart.getTime() + idx * slotMs < tournamentEnd.getTime()
        ? new Date(tournamentStart.getTime() + idx * slotMs).toISOString()
        : null;
    return {
      id: createId(),
      homeId: p.homeId,
      awayId: p.awayId,
      round: p.round,
      homeScore: null,
      awayScore: null,
      scheduledAt,
      status: "scheduled",
    };
  });

  return {
    db: {
      ...working,
      settings: { ...working.settings, fixturesGenerated: true },
      matches: [...working.matches, ...matches],
    },
    changed: true,
  };
}

type DatabaseLike = ReturnType<typeof readDb>;

export function loadDbWithFixtures() {
  let db = readDb();
  const { db: next, changed } = ensureFixturesGenerated(db);
  if (changed) {
    writeDb(next);
    db = next;
  }
  return db;
}

function emptyStandingsMap(
  players: { id: string; name: string }[],
): Map<string, Omit<StandingsRow, "rank"> & { playerName: string }> {
  const m = new Map<
    string,
    Omit<StandingsRow, "rank"> & { playerName: string }
  >();
  for (const p of players) {
    m.set(p.id, {
      playerId: p.id,
      playerName: p.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0,
    });
  }
  return m;
}

export function computeStandingsFromMatches(
  confirmedPlayers: { id: string; name: string }[],
  matches: {
    status: string;
    homeId: string;
    awayId: string;
    homeScore: number | null;
    awayScore: number | null;
  }[],
): StandingsRow[] {
  const map = emptyStandingsMap(confirmedPlayers);
  for (const m of matches) {
    if (m.status !== "completed" || m.homeScore == null || m.awayScore == null)
      continue;
    const home = map.get(m.homeId);
    const away = map.get(m.awayId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.goalsFor += m.homeScore;
    home.goalsAgainst += m.awayScore;
    away.goalsFor += m.awayScore;
    away.goalsAgainst += m.homeScore;

    if (m.homeScore > m.awayScore) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (m.homeScore < m.awayScore) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  for (const row of map.values()) {
    row.goalDifference = row.goalsFor - row.goalsAgainst;
  }

  const list = [...map.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference)
      return b.goalDifference - a.goalDifference;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return a.playerName.localeCompare(b.playerName);
  });

  return list.map((row, i) => ({
    rank: i + 1,
    playerId: row.playerId,
    playerName: row.playerName,
    played: row.played,
    won: row.won,
    drawn: row.drawn,
    lost: row.lost,
    goalsFor: row.goalsFor,
    goalsAgainst: row.goalsAgainst,
    goalDifference: row.goalDifference,
    points: row.points,
  }));
}

export async function getPublicTournamentState() {
  const db = loadDbWithFixtures();

  const now = new Date();
  const registrationOpen =
    now >= new Date(db.settings.registrationStartsAt) &&
    now < new Date(db.settings.registrationEndsAt);
  const registrationNotStarted = now < new Date(db.settings.registrationStartsAt);

  const confirmedPlayers = db.players
    .filter((p) => p.status === "confirmed")
    .map((p) => ({ id: p.id, name: p.konamiName || p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const playerById = new Map<string, PlayerRecord>(
    db.players.map((p) => [p.id, p]),
  );

  const matches = db.matches.map((m) => ({
    ...m,
    home: {
      id: m.homeId,
      name: playerById.get(m.homeId)?.konamiName ?? playerById.get(m.homeId)?.name ?? "?",
    },
    away: {
      id: m.awayId,
      name: playerById.get(m.awayId)?.konamiName ?? playerById.get(m.awayId)?.name ?? "?",
    },
  }));

  matches.sort((a, b) => {
    const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
    const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.round - b.round;
  });

  const standings = computeStandingsFromMatches(
    confirmedPlayers,
    db.matches.map((m) => ({
      status: m.status,
      homeId: m.homeId,
      awayId: m.awayId,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
    })),
  );

  return {
    tournamentName: db.settings.tournamentName,
    tournamentStopped: db.settings.tournamentStopped,
    registrationOpen,
    registrationNotStarted,
    registrationStartsAt: db.settings.registrationStartsAt,
    registrationEndsAt: db.settings.registrationEndsAt,
    fixturesGenerated: db.settings.fixturesGenerated,
    tournamentStartsAt: db.settings.tournamentStartsAt,
    tournamentEndsAt: db.settings.tournamentEndsAt,
    matchDurationMinutes: db.settings.matchDurationMinutes,
    breakMinutes: db.settings.breakMinutes,
    rulesMarkdown: db.settings.rulesMarkdown,
    matches,
    standings,
    confirmedCount: confirmedPlayers.length,
    totalRegistered: db.players.length,
  };
}
