import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type PlayerRecord = {
  id: string;
  name: string;
  email: string;
  phone: string;
  konamiName: string;
  paid: boolean;
  status: "pending" | "confirmed";
  createdAt: string;
};

export type ResultSubmissionRecord = {
  id: string;
  matchId: string | null;
  submittedByEmail: string;
  imagePath: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  parsedHomeScore: number | null;
  parsedAwayScore: number | null;
  ocrText: string | null;
  note: string | null;
};

export type MatchRecord = {
  id: string;
  round: number;
  homeId: string;
  awayId: string;
  homeScore: number | null;
  awayScore: number | null;
  scheduledAt: string | null;
  status: "scheduled" | "completed";
};

export type TournamentSettingsRecord = {
  id: "default";
  registrationStartsAt: string;
  registrationEndsAt: string;
  fixturesGenerated: boolean;
  tournamentName: string;
  tournamentStartsAt: string;
  tournamentEndsAt: string;
  matchDurationMinutes: number;
  breakMinutes: number;
  rulesMarkdown: string;
  /** When true, public registration and result uploads are blocked. */
  tournamentStopped: boolean;
};

export type Database = {
  settings: TournamentSettingsRecord;
  players: PlayerRecord[];
  matches: MatchRecord[];
  submissions: ResultSubmissionRecord[];
};

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "tournament.json");

function defaultEndsAt(): string {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
}

function defaultStartsAt(): string {
  return new Date(Date.now()).toISOString();
}

function defaultTournamentEndsAt(fromIso: string): string {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return defaultEndsAt();
  return new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
}

function emptyDb(): Database {
  const registrationStartsAt = defaultStartsAt();
  let registrationEndsAt = defaultEndsAt();
  if (process.env.REGISTRATION_ENDS_AT) {
    const d = new Date(process.env.REGISTRATION_ENDS_AT);
    if (!Number.isNaN(d.getTime())) registrationEndsAt = d.toISOString();
  }
  const tournamentStartsAt = registrationEndsAt;
  const tournamentEndsAt = defaultTournamentEndsAt(tournamentStartsAt);
  return {
    settings: {
      id: "default",
      registrationStartsAt,
      registrationEndsAt,
      fixturesGenerated: false,
      tournamentName: "Karatina Football Tournament",
      tournamentStartsAt,
      tournamentEndsAt,
      matchDurationMinutes: 90,
      breakMinutes: 15,
      rulesMarkdown:
        "- 11-a-side (or as announced)\n- 3 points win, 1 draw, 0 loss\n- Fair play: respect referees and opponents\n- Bring your own kit; arrive 15 minutes early\n",
      tournamentStopped: false,
    },
    players: [],
    matches: [],
    submissions: [],
  };
}

function migrateDb(db: Database): Database {
  const s = db.settings ?? (emptyDb().settings as TournamentSettingsRecord);

  const registrationStartsAt =
    (s as any).registrationStartsAt ?? defaultStartsAt();
  const registrationEndsAt = s.registrationEndsAt ?? defaultEndsAt();

  const tournamentStartsAt =
    (s as any).tournamentStartsAt ?? registrationEndsAt;
  const tournamentEndsAt =
    (s as any).tournamentEndsAt ?? defaultTournamentEndsAt(tournamentStartsAt);

  const matchDurationMinutes =
    typeof (s as any).matchDurationMinutes === "number"
      ? Math.max(10, Math.min(240, (s as any).matchDurationMinutes))
      : 90;
  const breakMinutes =
    typeof (s as any).breakMinutes === "number"
      ? Math.max(0, Math.min(120, (s as any).breakMinutes))
      : 15;

  const rulesMarkdown =
    typeof (s as any).rulesMarkdown === "string" ? (s as any).rulesMarkdown : "";

  const tournamentStopped =
    typeof (s as any).tournamentStopped === "boolean"
      ? (s as any).tournamentStopped
      : false;

  return {
    settings: {
      ...s,
      id: "default",
      registrationStartsAt: new Date(registrationStartsAt).toISOString(),
      registrationEndsAt: new Date(registrationEndsAt).toISOString(),
      tournamentStartsAt: new Date(tournamentStartsAt).toISOString(),
      tournamentEndsAt: new Date(tournamentEndsAt).toISOString(),
      matchDurationMinutes,
      breakMinutes,
      rulesMarkdown,
      tournamentStopped,
    },
    players: Array.isArray(db.players)
      ? db.players.map((p: any) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          email: String(p.email ?? ""),
          phone: String(p.phone ?? ""),
          konamiName: typeof p.konamiName === "string" ? p.konamiName : "",
          paid: typeof p.paid === "boolean" ? p.paid : false,
          status: p.status === "confirmed" ? "confirmed" : "pending",
          createdAt: new Date(p.createdAt ?? Date.now()).toISOString(),
        }))
      : [],
    matches: Array.isArray(db.matches) ? db.matches : [],
    submissions: Array.isArray((db as any).submissions)
      ? (db as any).submissions.map((sub: any) => ({
          id: String(sub.id ?? ""),
          matchId: sub.matchId ?? null,
          submittedByEmail: String(sub.submittedByEmail ?? ""),
          imagePath: String(sub.imagePath ?? ""),
          createdAt: new Date(sub.createdAt ?? Date.now()).toISOString(),
          status:
            sub.status === "approved" || sub.status === "rejected"
              ? sub.status
              : "pending",
          parsedHomeScore:
            typeof sub.parsedHomeScore === "number" ? sub.parsedHomeScore : null,
          parsedAwayScore:
            typeof sub.parsedAwayScore === "number" ? sub.parsedAwayScore : null,
          ocrText: typeof sub.ocrText === "string" ? sub.ocrText : null,
          note: typeof sub.note === "string" ? sub.note : null,
        }))
      : [],
  };
}

export function readDb(): Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DB_PATH)) {
    const init = emptyDb();
    writeFileSync(DB_PATH, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    const raw = readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Database;
    if (!parsed.settings || !Array.isArray(parsed.players)) {
      return emptyDb();
    }
    const migrated = migrateDb(parsed);
    // If migrations changed shape, persist it.
    writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2), "utf8");
    return migrated;
  } catch {
    return emptyDb();
  }
}

export function writeDb(db: Database) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
