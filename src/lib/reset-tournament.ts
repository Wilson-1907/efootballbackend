import { rmSync, existsSync } from "fs";
import { join } from "path";
import type { Database } from "./db.js";

const UPLOADS = join(process.cwd(), "data", "uploads");

export function deleteUploadFiles() {
  if (existsSync(UPLOADS)) {
    try {
      rmSync(UPLOADS, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Clear players, matches, submissions; reset fixtures flag; optionally clear stopped flag. */
export function wipeCompetitionData(db: Database): Database {
  return {
    ...db,
    settings: {
      ...db.settings,
      fixturesGenerated: false,
      tournamentStopped: false,
    },
    players: db.players.map((p) => ({
      ...p,
      seasonReserved: false,
    })),
    matches: [],
    submissions: [],
    watcherBookings: [],
  };
}
