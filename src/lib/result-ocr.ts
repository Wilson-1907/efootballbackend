import type { Database, MatchRecord, PlayerRecord } from "./db.js";

export function normalizeKonami(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/gi, "");
}

function nameAppearsInOcr(konami: string, ocrNorm: string, ocrRaw: string): boolean {
  const k = normalizeKonami(konami);
  if (k.length < 2) return false;
  if (ocrNorm.includes(k)) return true;
  const words = konami.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return false;
  return words.every((w) => ocrRaw.toLowerCase().includes(w.toLowerCase()));
}

export function parseScoresFromOcr(text: string): { a: number; b: number } | null {
  const re = /\b(\d{1,2})\s*[-:–]\s*(\d{1,2})\b/g;
  let best: { a: number; b: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a > 20 || b > 20) continue;
    best = { a, b };
  }
  return best;
}

const MS_HOUR = 60 * 60 * 1000;

export function isWithinMatchTimeWindow(
  scheduledAt: string | null,
  now: Date,
  hoursBefore = 2,
  hoursAfter = 72,
): boolean {
  if (!scheduledAt) return false;
  const t = new Date(scheduledAt).getTime();
  if (Number.isNaN(t)) return false;
  const start = t - hoursBefore * MS_HOUR;
  const end = t + hoursAfter * MS_HOUR;
  const n = now.getTime();
  return n >= start && n <= end;
}

/**
 * Picks home/away scores from OCR numbers (a,b) using name order before the score line.
 */
function mapScoresToHomeAway(
  ocrText: string,
  homeKonami: string,
  awayKonami: string,
  a: number,
  b: number,
): { homeScore: number; awayScore: number } {
  const lower = ocrText.toLowerCase();
  const idxScore = lower.search(/\d{1,2}\s*[-:–]\s*\d{1,2}/);
  const slice = idxScore >= 0 ? lower.slice(0, idxScore) : lower;
  const h = homeKonami.toLowerCase();
  const aw = awayKonami.toLowerCase();
  const lastH = slice.lastIndexOf(h.slice(0, Math.min(h.length, 12)));
  const lastA = slice.lastIndexOf(aw.slice(0, Math.min(aw.length, 12)));
  if (lastH >= 0 && lastA >= 0) {
    if (lastH <= lastA) return { homeScore: a, awayScore: b };
    return { homeScore: b, awayScore: a };
  }
  return { homeScore: a, awayScore: b };
}

export function findValidatedMatch(args: {
  db: Database;
  ocrText: string;
  now: Date;
}): {
  match: MatchRecord;
  homeScore: number;
  awayScore: number;
} | null {
  const { db, ocrText, now } = args;
  const parsed = parseScoresFromOcr(ocrText);
  if (!parsed) return null;

  const ocrNorm = normalizeKonami(ocrText);
  const playersById = new Map<string, PlayerRecord>(
    db.players.map((p) => [p.id, p]),
  );

  type Cand = { match: MatchRecord; homeScore: number; awayScore: number; dist: number };
  const cands: Cand[] = [];

  for (const m of db.matches) {
    if (m.status === "completed") continue;
    const home = playersById.get(m.homeId);
    const away = playersById.get(m.awayId);
    if (!home || !away) continue;
    if (home.status !== "confirmed" || away.status !== "confirmed") continue;
    if (!isWithinMatchTimeWindow(m.scheduledAt, now)) continue;

    const hk = home.konamiName || home.name;
    const ak = away.konamiName || away.name;
    if (!nameAppearsInOcr(hk, ocrNorm, ocrText) || !nameAppearsInOcr(ak, ocrNorm, ocrText)) {
      continue;
    }

    const { homeScore, awayScore } = mapScoresToHomeAway(ocrText, hk, ak, parsed.a, parsed.b);
    const t = m.scheduledAt ? new Date(m.scheduledAt).getTime() : now.getTime();
    const dist = Math.abs(t - now.getTime());
    cands.push({ match: m, homeScore, awayScore, dist });
  }

  if (cands.length === 0) return null;
  cands.sort((x, y) => x.dist - y.dist);
  const best = cands[0]!;
  return {
    match: best.match,
    homeScore: best.homeScore,
    awayScore: best.awayScore,
  };
}
