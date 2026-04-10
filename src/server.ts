import dotenv from "dotenv";
import { join } from "path";
dotenv.config({ path: join(process.cwd(), ".env") });
dotenv.config({ path: join(process.cwd(), "..", ".env") });

import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import multer from "multer";
import { buildAdminOverview } from "./admin-overview.js";
import { requireAdmin } from "./admin-middleware.js";
import {
  ADMIN_COOKIE,
  computeAdminSessionToken,
} from "./lib/admin-token.js";
import {
  createId,
  readDb,
  writeDb,
  type ResultSubmissionRecord,
} from "./lib/db.js";
import {
  PLAYER_COOKIE,
  createPlayerSessionToken,
  hashPassword,
  resolvePlayerFromToken,
  verifyPassword,
} from "./lib/player-auth.js";
import {
  findValidatedMatch,
  normalizeKonami,
  parseScoresFromOcr,
} from "./lib/result-ocr.js";
import { deleteUploadFiles, wipeCompetitionData } from "./lib/reset-tournament.js";
import {
  ensureFixturesGenerated,
  getPublicTournamentState,
  loadDbWithFixtures,
} from "./lib/tournament.js";

const PORT = Number(process.env.PORT) || 4000;
const UPLOAD_DIR = join(process.cwd(), "data", "uploads");
const UPLOAD_ROOT = UPLOAD_DIR;

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

function buildCodeSendAt(scheduledAt: string | null): string | null {
  if (!scheduledAt) return null;
  const t = new Date(scheduledAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t - 8 * 60 * 1000).toISOString();
}

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

function requirePlayerSession(req: express.Request) {
  const db = readDb();
  const secret = process.env.SESSION_SECRET ?? "dev-change-me";
  const token = getCookie(req.headers.cookie, PLAYER_COOKIE);
  const player = resolvePlayerFromToken(token, db.players, secret);
  return { db, player };
}

function playersWithSameKonami(
  players: { id: string; konamiName: string }[],
  rawKonami: string,
  excludePlayerId?: string,
): { id: string; konamiName: string }[] {
  const key = normalizeKonami(rawKonami.trim());
  if (key.length < 2) return [];
  return players.filter(
    (p) =>
      p.id !== excludePlayerId && normalizeKonami(p.konamiName || "") === key,
  );
}

async function runOcr(buffer: Buffer): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const {
      data: { text },
    } = await worker.recognize(buffer);
    return text ?? "";
  } finally {
    await worker.terminate();
  }
}

app.get("/api/public/state", async (_req, res) => {
  try {
    const state = await getPublicTournamentState();
    res.json(state);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/** Minimal public data for the pre-login screen (no fixtures, standings, or player lists). */
app.get("/api/public/meta", (_req, res) => {
  try {
    const db = readDb();
    const now = new Date();
    const registrationOpen =
      now >= new Date(db.settings.registrationStartsAt) &&
      now < new Date(db.settings.registrationEndsAt);
    const registrationNotStarted = now < new Date(db.settings.registrationStartsAt);
    const ev = db.settings.publicEventDateTime;
    const finalsBookingOpen =
      typeof ev === "string" &&
      ev.length > 0 &&
      !Number.isNaN(new Date(ev).getTime()) &&
      (db.settings.publicVenue ?? "").trim().length > 0;
    res.json({
      tournamentName: db.settings.tournamentName,
      tournamentStopped: db.settings.tournamentStopped,
      registrationOpen,
      registrationNotStarted,
      registrationStartsAt: db.settings.registrationStartsAt,
      registrationEndsAt: db.settings.registrationEndsAt,
      finalsBookingOpen,
      publicEventDateTime: db.settings.publicEventDateTime,
      publicVenue: db.settings.publicVenue,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/player/account/create", (req, res) => {
  let body: {
    name?: string;
    email?: string;
    phone?: string;
    konamiName?: string;
    password?: string;
    passwordConfirm?: string;
  };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const name = body.name?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const phone = body.phone?.trim() ?? "";
  const konamiName = body.konamiName?.trim() ?? "";
  const password = body.password ?? "";
  const passwordConfirm = body.passwordConfirm ?? "";

  if (!name || !email || !phone || !konamiName || password.length < 6) {
    res.status(400).json({
      error:
        "Name, email, phone, Konami name, and password (min 6 characters) are required.",
    });
    return;
  }
  if (password !== passwordConfirm) {
    res.status(400).json({ error: "Passwords do not match. Enter the same password twice." });
    return;
  }

  let db = readDb();
  const secret = process.env.SESSION_SECRET ?? "dev-change-me";
  const existingIdx = db.players.findIndex((p) => p.email === email);
  let player: (typeof db.players)[number];
  if (existingIdx >= 0) {
    const existing = db.players[existingIdx]!;
    if (existing.passwordHash) {
      res.status(409).json({
        error: "Account already exists for this email. Please log in with your Konami name.",
      });
      return;
    }
    const clash = playersWithSameKonami(db.players, konamiName, existing.id);
    if (clash.length > 0) {
      res.status(409).json({
        error: "Another player already uses this Konami name. Pick a different in-game name.",
      });
      return;
    }
    const players = [...db.players];
    player = {
      ...existing,
      name,
      phone,
      konamiName,
      passwordHash: hashPassword(password, secret),
    };
    players[existingIdx] = player;
    db = { ...db, players };
  } else {
    if (playersWithSameKonami(db.players, konamiName).length > 0) {
      res.status(409).json({
        error: "Another player already uses this Konami name. Pick a different in-game name.",
      });
      return;
    }
    player = {
      id: createId(),
      name,
      email,
      phone,
      konamiName,
      passwordHash: hashPassword(password, secret),
      seasonReserved: false,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    db = { ...db, players: [...db.players, player] };
  }
  writeDb(db);

  const token = createPlayerSessionToken(player, secret);
  const crossSite = (process.env.CROSS_SITE_COOKIES ?? "").toLowerCase() === "true";
  res.cookie(PLAYER_COOKIE, token, {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite ? true : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30 * 1000,
  });

  res.json({
    ok: true,
    message:
      "Account created. Log in with your Konami name and password. When player registration is open, use “Save spot for this season”.",
    player: { id: player.id, name: player.name, email: player.email },
  });
});

app.post("/api/player/login", (req, res) => {
  let body: { konamiName?: string; password?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  const konamiRaw = body.konamiName?.trim() ?? "";
  const password = body.password ?? "";
  if (!konamiRaw || !password) {
    res.status(400).json({ error: "Konami name and password are required." });
    return;
  }

  const db = readDb();
  const key = normalizeKonami(konamiRaw);
  if (key.length < 2) {
    res.status(400).json({ error: "Enter a valid Konami / eFootball name." });
    return;
  }
  const matches = db.players.filter(
    (p) => normalizeKonami(p.konamiName || "") === key,
  );
  if (matches.length === 0) {
    res.status(401).json({ error: "Invalid Konami name or password." });
    return;
  }
  if (matches.length > 1) {
    res.status(409).json({
      error:
        "Multiple accounts share this Konami name. Contact the organiser to fix duplicate names.",
    });
    return;
  }
  const player = matches[0]!;
  const secret = process.env.SESSION_SECRET ?? "dev-change-me";
  if (!verifyPassword(password, player.passwordHash, secret)) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  const token = createPlayerSessionToken(player, secret);
  const crossSite = (process.env.CROSS_SITE_COOKIES ?? "").toLowerCase() === "true";
  res.cookie(PLAYER_COOKIE, token, {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite ? true : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/player/logout", (_req, res) => {
  res.cookie(PLAYER_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.json({ ok: true });
});

app.get("/api/player/me", (req, res) => {
  const { db, player } = requirePlayerSession(req);
  if (!player) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const playerById = new Map(db.players.map((p) => [p.id, p]));
  const mySubmissions = db.submissions.filter((s) => s.submittedByEmail === player.email);
  const fixtures = db.matches
    .filter((m) => m.homeId === player.id || m.awayId === player.id)
    .map((m) => ({
      id: m.id,
      stage: m.stage,
      status: m.status,
      scheduledAt: m.scheduledAt,
      fixtureCode: m.fixtureCode,
      codeSendAt: m.codeSendAt,
      homeCodeSubmittedAt: m.homeCodeSubmittedAt,
      awayCodeSubmittedAt: m.awayCodeSubmittedAt,
      homeId: m.homeId,
      awayId: m.awayId,
      home: {
        id: m.homeId,
        name: playerById.get(m.homeId)?.konamiName || playerById.get(m.homeId)?.name || "?",
      },
      away: {
        id: m.awayId,
        name: playerById.get(m.awayId)?.konamiName || playerById.get(m.awayId)?.name || "?",
      },
      isHome: m.homeId === player.id,
    }))
    .sort((a, b) => {
      const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
      const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
      return ta - tb;
    });

  res.json({
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      phone: player.phone,
      konamiName: player.konamiName,
      status: player.status,
      seasonReserved: player.seasonReserved,
    },
    fixtures,
    progress: {
      submitted: mySubmissions.length,
      approved: mySubmissions.filter((s) => s.status === "approved").length,
      rejected: mySubmissions.filter((s) => s.status === "rejected").length,
    },
  });
});

app.post("/api/player/reserve-spot", (req, res) => {
  let db = readDb();
  const secret = process.env.SESSION_SECRET ?? "dev-change-me";
  const token = getCookie(req.headers.cookie, PLAYER_COOKIE);
  const player = resolvePlayerFromToken(token, db.players, secret);
  if (!player) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const now = new Date();
  if (db.settings.tournamentStopped) {
    res.status(403).json({ error: "Tournament is stopped. Registration is closed." });
    return;
  }
  if (now < new Date(db.settings.registrationStartsAt)) {
    res.status(400).json({ error: "Registration has not opened yet." });
    return;
  }
  if (now >= new Date(db.settings.registrationEndsAt)) {
    res.status(400).json({ error: "Registration has closed." });
    return;
  }
  const idx = db.players.findIndex((p) => p.id === player.id);
  if (idx < 0) {
    res.status(404).json({ error: "Player not found." });
    return;
  }
  if (db.players[idx]!.seasonReserved) {
    res.json({ ok: true, message: "Spot already reserved for this season." });
    return;
  }
  const players = [...db.players];
  players[idx] = { ...players[idx]!, seasonReserved: true, status: "pending" };
  db = { ...db, players };
  writeDb(db);
  res.json({ ok: true, message: "Spot reserved. Waiting for admin approval." });
});

app.post("/api/watchers/book", (req, res) => {
  let body: { name?: string; email?: string; phone?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  const name = body.name?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const phone = body.phone?.trim() ?? "";
  if (!name || !email || !phone) {
    res.status(400).json({ error: "Name, email and phone are required." });
    return;
  }
  const db = readDb();
  if (db.settings.tournamentStopped) {
    res.status(403).json({ error: "Tournament is not accepting bookings." });
    return;
  }
  const eventIso = db.settings.publicEventDateTime;
  const venue = db.settings.publicVenue?.trim() ?? "";
  const eventOk = Boolean(eventIso && !Number.isNaN(new Date(eventIso).getTime()));
  if (!eventOk || !venue) {
    res.status(400).json({
      error:
        "Semifinal/final day is not published yet. The organiser must set public event date and venue before seats can be booked.",
    });
    return;
  }
  if (db.watcherBookings.some((b) => b.email === email)) {
    res.json({ ok: true, message: "You already booked a finals seat." });
    return;
  }
  const next = {
    ...db,
    watcherBookings: [
      ...db.watcherBookings,
      { id: createId(), name, email, phone, createdAt: new Date().toISOString() },
    ],
  };
  writeDb(next);
  res.json({ ok: true, message: "Seat booked for semi-finals and finals day." });
});

app.post("/api/player/matches/:matchId/submit-code", (req, res) => {
  const { db, player } = requirePlayerSession(req);
  if (!player) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const matchId = req.params.matchId;
  const rawCode = String(req.body?.code ?? "").trim().toUpperCase();
  if (!matchId || !rawCode) {
    res.status(400).json({ error: "Match and code are required." });
    return;
  }
  const idx = db.matches.findIndex((m) => m.id === matchId);
  if (idx === -1) {
    res.status(404).json({ error: "Match not found." });
    return;
  }
  const match = db.matches[idx]!;
  if (match.homeId !== player.id && match.awayId !== player.id) {
    res.status(403).json({ error: "You are not a player in this match." });
    return;
  }
  if ((match.fixtureCode ?? "").toUpperCase() !== rawCode) {
    res.status(400).json({ error: "Invalid match code." });
    return;
  }

  const now = new Date().toISOString();
  const updated = [...db.matches];
  if (match.homeId === player.id) {
    if (match.homeCodeSubmittedAt) {
      res.json({ ok: true, message: "Your code was already recorded." });
      return;
    }
    updated[idx] = { ...match, homeCodeSubmittedAt: now };
  } else {
    if (match.awayCodeSubmittedAt) {
      res.json({ ok: true, message: "Your code was already recorded." });
      return;
    }
    updated[idx] = { ...match, awayCodeSubmittedAt: now };
  }
  writeDb({ ...db, matches: updated });
  res.json({ ok: true, message: "Code recorded on your account." });
});

app.get("/api/admin/overview", requireAdmin, (_req, res) => {
  try {
    const db = loadDbWithFixtures();
    res.json(buildAdminOverview(db));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/register", (req, res) => {
  let db = readDb();
  if (db.settings.tournamentStopped) {
    res.status(403).json({
      error: "Tournament is stopped. Registration is closed.",
    });
    return;
  }
  const now = new Date();
  if (now < new Date(db.settings.registrationStartsAt)) {
    res.status(400).json({ error: "Registration has not opened yet." });
    return;
  }
  if (now >= new Date(db.settings.registrationEndsAt)) {
    res.status(400).json({ error: "Registration has closed." });
    return;
  }

  let body: { name?: string; email?: string; phone?: string; konamiName?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim();
  const konamiName = body.konamiName?.trim();

  if (!name || !email || !phone || !konamiName) {
    res.status(400).json({
      error: "Name, email, phone, and Konami/eFootball name are required.",
    });
    return;
  }

  const existing = db.players.find((p) => p.email === email);
  if (existing) {
    res.status(409).json({ error: "This email is already registered." });
    return;
  }

  const player = {
    id: createId(),
    name,
    email,
    phone,
    konamiName,
    passwordHash: null,
    seasonReserved: true,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };

  db = { ...db, players: [...db.players, player] };
  writeDb(db);

  res.json({
    ok: true,
    message: "Registration received. An admin will review and approve your entry.",
    player: { id: player.id, name: player.name, createdAt: player.createdAt },
  });
});

app.post("/api/admin/login", async (req, res) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    res.status(500).json({
      error: "Server is not configured (ADMIN_PASSWORD missing).",
    });
    return;
  }

  let body: { password?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  if (body.password !== password) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const secret = process.env.SESSION_SECRET ?? "dev-change-me";
  const token = await computeAdminSessionToken(secret);
  const crossSite = (process.env.CROSS_SITE_COOKIES ?? "").toLowerCase() === "true";
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite ? true : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  res.cookie(ADMIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, (_req, res) => {
  const db = readDb();
  res.json({
    registrationStartsAt: db.settings.registrationStartsAt,
    registrationEndsAt: db.settings.registrationEndsAt,
    tournamentName: db.settings.tournamentName,
    tournamentStartsAt: db.settings.tournamentStartsAt,
    tournamentEndsAt: db.settings.tournamentEndsAt,
    matchDurationMinutes: db.settings.matchDurationMinutes,
    breakMinutes: db.settings.breakMinutes,
    rulesMarkdown: db.settings.rulesMarkdown,
    publicEventDateTime: db.settings.publicEventDateTime,
    publicVenue: db.settings.publicVenue,
    fixturesGenerated: db.settings.fixturesGenerated,
    tournamentStopped: db.settings.tournamentStopped,
  });
});

app.patch("/api/admin/settings", requireAdmin, (req, res) => {
  let body: {
    registrationStartsAt?: string;
    registrationEndsAt?: string;
    tournamentName?: string;
    tournamentStartsAt?: string;
    tournamentEndsAt?: string;
    matchDurationMinutes?: number;
    breakMinutes?: number;
    rulesMarkdown?: string;
    publicEventDateTime?: string | null;
    publicVenue?: string;
  };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  let db = readDb();
  const settings = { ...db.settings };

  if (body.tournamentName?.trim()) {
    settings.tournamentName = body.tournamentName.trim().slice(0, 120);
  }
  if (body.registrationStartsAt) {
    const d = new Date(body.registrationStartsAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "Invalid registrationStartsAt" });
      return;
    }
    settings.registrationStartsAt = d.toISOString();
  }
  if (body.registrationEndsAt) {
    const d = new Date(body.registrationEndsAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "Invalid registrationEndsAt" });
      return;
    }
    settings.registrationEndsAt = d.toISOString();
  }
  if (body.tournamentStartsAt) {
    const d = new Date(body.tournamentStartsAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "Invalid tournamentStartsAt" });
      return;
    }
    settings.tournamentStartsAt = d.toISOString();
  }
  if (body.tournamentEndsAt) {
    const d = new Date(body.tournamentEndsAt);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "Invalid tournamentEndsAt" });
      return;
    }
    settings.tournamentEndsAt = d.toISOString();
  }
  if (typeof body.matchDurationMinutes === "number") {
    settings.matchDurationMinutes = Math.max(
      10,
      Math.min(240, body.matchDurationMinutes),
    );
  }
  if (typeof body.breakMinutes === "number") {
    settings.breakMinutes = Math.max(0, Math.min(120, body.breakMinutes));
  }
  if (typeof body.rulesMarkdown === "string") {
    settings.rulesMarkdown = body.rulesMarkdown.slice(0, 8000);
  }
  if (body.publicEventDateTime !== undefined) {
    if (body.publicEventDateTime === null || body.publicEventDateTime === "") {
      settings.publicEventDateTime = null;
    } else {
      const d = new Date(body.publicEventDateTime);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "Invalid publicEventDateTime" });
        return;
      }
      settings.publicEventDateTime = d.toISOString();
    }
  }
  if (typeof body.publicVenue === "string") {
    settings.publicVenue = body.publicVenue.trim().slice(0, 240);
  }

  if (
    body.tournamentName === undefined &&
    body.registrationStartsAt === undefined &&
    body.registrationEndsAt === undefined &&
    body.tournamentStartsAt === undefined &&
    body.tournamentEndsAt === undefined &&
    body.matchDurationMinutes === undefined &&
    body.breakMinutes === undefined &&
    body.rulesMarkdown === undefined &&
    body.publicEventDateTime === undefined &&
    body.publicVenue === undefined
  ) {
    res.status(400).json({ error: "No valid fields" });
    return;
  }

  db = { ...db, settings };
  const gen = ensureFixturesGenerated(db);
  db = gen.db;
  writeDb(db);

  res.json({
    registrationStartsAt: db.settings.registrationStartsAt,
    registrationEndsAt: db.settings.registrationEndsAt,
    tournamentName: db.settings.tournamentName,
    tournamentStartsAt: db.settings.tournamentStartsAt,
    tournamentEndsAt: db.settings.tournamentEndsAt,
    matchDurationMinutes: db.settings.matchDurationMinutes,
    breakMinutes: db.settings.breakMinutes,
    rulesMarkdown: db.settings.rulesMarkdown,
    publicEventDateTime: db.settings.publicEventDateTime,
    publicVenue: db.settings.publicVenue,
    fixturesGenerated: db.settings.fixturesGenerated,
    tournamentStopped: db.settings.tournamentStopped,
  });
});

app.post("/api/admin/matches/update", requireAdmin, (req, res) => {
  let body: {
    matchId?: string;
    homeScore?: number | null;
    awayScore?: number | null;
    scheduledAt?: string | null;
    status?: string;
    homeId?: string;
    awayId?: string;
  };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const { matchId, homeScore, awayScore, scheduledAt, status, homeId, awayId } = body;
  if (!matchId) {
    res.status(400).json({ error: "matchId required" });
    return;
  }

  let db = readDb();
  const idx = db.matches.findIndex((m) => m.id === matchId);
  if (idx === -1) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  const match = { ...db.matches[idx]! };

  if (homeId !== undefined || awayId !== undefined) {
    const nextHomeId = homeId ?? match.homeId;
    const nextAwayId = awayId ?? match.awayId;

    if (!nextHomeId || !nextAwayId || nextHomeId === nextAwayId) {
      res.status(400).json({ error: "Home and away players must be different." });
      return;
    }

    const homePlayer = db.players.find((p) => p.id === nextHomeId);
    const awayPlayer = db.players.find((p) => p.id === nextAwayId);
    if (!homePlayer || !awayPlayer) {
      res.status(400).json({ error: "Selected player was not found." });
      return;
    }
    if (homePlayer.status !== "confirmed" || awayPlayer.status !== "confirmed") {
      res.status(400).json({ error: "Only confirmed players can be assigned." });
      return;
    }

    match.homeId = nextHomeId;
    match.awayId = nextAwayId;
  }

  if (scheduledAt !== undefined) {
    if (scheduledAt === null || scheduledAt === "") {
      match.scheduledAt = null;
    } else {
      const d = new Date(scheduledAt);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "Invalid scheduledAt" });
        return;
      }
      match.scheduledAt = d.toISOString();
    }
    match.codeSendAt = buildCodeSendAt(match.scheduledAt);
    if (!match.fixtureCode) {
      match.fixtureCode = createId().slice(-6).toUpperCase();
    }
  }

  if (homeScore !== undefined) match.homeScore = homeScore;
  if (awayScore !== undefined) match.awayScore = awayScore;
  if (status !== undefined) {
    if (status !== "scheduled" && status !== "completed") {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    match.status = status;
  }

  if (
    match.homeScore != null &&
    match.awayScore != null &&
    status === undefined &&
    body.status === undefined
  ) {
    match.status = "completed";
  }

  const matches = [...db.matches];
  matches[idx] = match;
  db = { ...db, matches };
  writeDb(db);

  res.json({ ok: true });
});

app.post("/api/admin/players/confirm", requireAdmin, (req, res) => {
  let body: { playerId?: string; status?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const playerId = body.playerId;
  const status = body.status;
  if (!playerId || (status !== "pending" && status !== "confirmed")) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  let db = readDb();
  const idx = db.players.findIndex((p) => p.id === playerId);
  if (idx === -1) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const players = [...db.players];
  const prev = players[idx]!;
  players[idx] = {
    ...prev,
    status: status as "pending" | "confirmed",
  };
  db = { ...db, players };
  const gen = ensureFixturesGenerated(db);
  db = gen.db;
  writeDb(db);

  res.json({ ok: true });
});

app.post("/api/admin/tournament/reset", requireAdmin, (_req, res) => {
  const db = readDb();
  const cleared = {
    ...db,
    players: [],
    matches: [],
    submissions: [],
    settings: {
      ...db.settings,
      fixturesGenerated: false,
      tournamentStopped: false,
    },
  };
  writeDb(cleared);
  res.json({ ok: true });
});

app.post("/api/admin/tournament/end", requireAdmin, (_req, res) => {
  const db = readDb();
  const cleared = {
    ...db,
    players: [],
    matches: [],
    submissions: [],
    settings: {
      ...db.settings,
      fixturesGenerated: false,
      tournamentStopped: true,
    },
  };
  writeDb(cleared);
  res.json({ ok: true });
});

app.post("/api/admin/tournament", requireAdmin, (req, res) => {
  let body: { action?: string };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const action = body.action;
  let db = readDb();

  if (action === "stop") {
    db = {
      ...db,
      settings: { ...db.settings, tournamentStopped: true },
    };
    writeDb(db);
    res.json({ ok: true, tournamentStopped: true });
    return;
  }

  if (action === "end") {
    deleteUploadFiles();
    db = wipeCompetitionData(db);
    writeDb(db);
    res.json({ ok: true, cleared: true });
    return;
  }

  if (action === "start-new") {
    deleteUploadFiles();
    db = wipeCompetitionData(db);
    writeDb(db);
    res.json({ ok: true, cleared: true });
    return;
  }

  res.status(400).json({ error: "Unknown action" });
});

app.post("/api/admin/submissions/approve", requireAdmin, (req, res) => {
  let body: {
    submissionId?: string;
    action?: "approve" | "reject";
    homeScore?: number;
    awayScore?: number;
  };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const { submissionId, action } = body;
  if (!submissionId || (action !== "approve" && action !== "reject")) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  let db = readDb();
  const si = db.submissions.findIndex((s) => s.id === submissionId);
  if (si === -1) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const sub = db.submissions[si]!;
  if (sub.status !== "pending") {
    res.status(400).json({ error: "Already processed" });
    return;
  }

  if (action === "reject") {
    const subs = [...db.submissions];
    subs[si] = { ...sub, status: "rejected" };
    db = { ...db, submissions: subs };
    writeDb(db);
    res.json({ ok: true });
    return;
  }

  const matchId = sub.matchId;
  if (!matchId) {
    res.status(400).json({
      error:
        "Submission has no linked match. Edit scores in Matches table or re-upload with clearer screenshot.",
    });
    return;
  }

  let hs =
    typeof body.homeScore === "number"
      ? body.homeScore
      : sub.parsedHomeScore;
  let as =
    typeof body.awayScore === "number"
      ? body.awayScore
      : sub.parsedAwayScore;

  if (hs == null || as == null || hs < 0 || as < 0) {
    res.status(400).json({
      error: "Valid home and away scores are required to approve.",
    });
    return;
  }

  const mi = db.matches.findIndex((m) => m.id === matchId);
  if (mi === -1) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  const matches = [...db.matches];
  matches[mi] = {
    ...matches[mi]!,
    homeScore: hs,
    awayScore: as,
    status: "completed",
  };

  const subs = [...db.submissions];
  subs[si] = { ...sub, status: "approved" };

  db = { ...db, matches, submissions: subs };
  writeDb(db);

  res.json({ ok: true });
});

app.post(
  "/api/results/upload",
  upload.single("screenshot"),
  async (req, res) => {
    let db = readDb();
    if (db.settings.tournamentStopped) {
      res.status(403).json({ error: "Tournament has ended." });
      return;
    }
    if (!db.settings.fixturesGenerated || db.matches.length === 0) {
      res.status(400).json({ error: "Fixtures are not available yet." });
      return;
    }

    const file = req.file;
    const emailRaw = typeof req.body?.email === "string" ? req.body.email : "";
    if (!file || !emailRaw) {
      res.status(400).json({
        error: "Screenshot and email are required.",
      });
      return;
    }

    const email = emailRaw.trim().toLowerCase();
    const submitter = db.players.find((p) => p.email === email);
    if (!submitter || submitter.status !== "confirmed") {
      res.status(403).json({
        error:
          "Email not found or player not confirmed. Use the email you registered with.",
      });
      return;
    }

    const buf = file.buffer;
    if (!buf || buf.length > 6 * 1024 * 1024) {
      res.status(400).json({ error: "Image too large (max 6MB)." });
      return;
    }

    if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
    const ext =
      file.mimetype?.includes("png")
        ? "png"
        : file.mimetype?.includes("webp")
          ? "webp"
          : "jpg";
    const imagePath = join("data", "uploads", `${createId()}.${ext}`);
    const abs = join(process.cwd(), imagePath);
    writeFileSync(abs, buf);

    let ocrText: string;
    try {
      ocrText = await runOcr(buf);
    } catch (e) {
      const sub: ResultSubmissionRecord = {
        id: createId(),
        matchId: null,
        submittedByEmail: email,
        imagePath,
        createdAt: new Date().toISOString(),
        status: "rejected",
        parsedHomeScore: null,
        parsedAwayScore: null,
        ocrText: null,
        note: `OCR failed: ${e instanceof Error ? e.message : "unknown"}`,
      };
      db = { ...db, submissions: [...db.submissions, sub] };
      writeDb(db);
      res.status(422).json({
        error: "Could not read text from image. Try a clearer screenshot.",
      });
      return;
    }

    const now = new Date();
    const parsedScore = parseScoresFromOcr(ocrText);

    if (!parsedScore) {
      const sub: ResultSubmissionRecord = {
        id: createId(),
        matchId: null,
        submittedByEmail: email,
        imagePath,
        createdAt: now.toISOString(),
        status: "rejected",
        parsedHomeScore: null,
        parsedAwayScore: null,
        ocrText: ocrText.slice(0, 4000),
        note: "Rejected: no readable score (e.g. 2-1) on screenshot.",
      };
      db = { ...db, submissions: [...db.submissions, sub] };
      writeDb(db);
      res.status(422).json({
        error:
          "Rejected — put the correct results. We could not read a final score on the image (use a clear screenshot showing something like 2-1 or 2:1).",
        ocrPreview: ocrText.slice(0, 500),
      });
      return;
    }

    const found = findValidatedMatch({ db, ocrText, now });

    if (!found) {
      const sub: ResultSubmissionRecord = {
        id: createId(),
        matchId: null,
        submittedByEmail: email,
        imagePath,
        createdAt: now.toISOString(),
        status: "rejected",
        parsedHomeScore: null,
        parsedAwayScore: null,
        ocrText: ocrText.slice(0, 4000),
        note: "Rejected: screenshot does not match any scheduled fixture (names, score, or time window).",
      };
      db = { ...db, submissions: [...db.submissions, sub] };
      writeDb(db);
      res.status(422).json({
        error:
          "Rejected — put the correct results. This image does not match any fixture on our schedule. Upload a screenshot of your actual scheduled match: both Konami names must match what you registered here, the score must be visible, and it must be within the allowed time around that fixture. Check Fixtures & scores on the site, then try again.",
        ocrPreview: ocrText.slice(0, 500),
      });
      return;
    }

    const { match, homeScore, awayScore } = found;
    const homeP = db.players.find((p) => p.id === match.homeId);
    const awayP = db.players.find((p) => p.id === match.awayId);
    if (!homeP || !awayP) {
      res.status(500).json({ error: "Player data missing." });
      return;
    }

    if (submitter.id !== homeP.id && submitter.id !== awayP.id) {
      const sub: ResultSubmissionRecord = {
        id: createId(),
        matchId: match.id,
        submittedByEmail: email,
        imagePath,
        createdAt: now.toISOString(),
        status: "rejected",
        parsedHomeScore: homeScore,
        parsedAwayScore: awayScore,
        ocrText: ocrText.slice(0, 4000),
        note: "Uploader is not a player in this fixture.",
      };
      db = { ...db, submissions: [...db.submissions, sub] };
      writeDb(db);
      res.status(403).json({
        error: "Only one of the two players in this match may submit the result.",
      });
      return;
    }

    const idx = db.matches.findIndex((m) => m.id === match.id);
    if (idx === -1) {
      res.status(500).json({ error: "Match not found." });
      return;
    }

    const updated = [...db.matches];
    updated[idx] = {
      ...updated[idx]!,
      homeScore,
      awayScore,
      status: "completed",
    };

    const approved: ResultSubmissionRecord = {
      id: createId(),
      matchId: match.id,
      submittedByEmail: email,
      imagePath,
      createdAt: now.toISOString(),
      status: "approved",
      parsedHomeScore: homeScore,
      parsedAwayScore: awayScore,
      ocrText: ocrText.slice(0, 4000),
      note: "Auto-approved: names, schedule, and score validated.",
    };

    db = {
      ...db,
      matches: updated,
      submissions: [...db.submissions, approved],
    };
    writeDb(db);

    res.json({
      ok: true,
      message: "Result recorded and standings updated.",
      matchId: match.id,
      homeScore,
      awayScore,
    });
  },
);

app.get("/api/uploads/:file", (req, res) => {
  const name = req.params.file ?? "";
  if (
    !name ||
    name.includes("..") ||
    !/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp)$/i.test(name)
  ) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const full = join(UPLOAD_ROOT, name);
  if (!full.startsWith(UPLOAD_ROOT) || !existsSync(full)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const buf = readFileSync(full);
  const lower = name.toLowerCase();
  const type = lower.endsWith("png")
    ? "image/png"
    : lower.endsWith("webp")
      ? "image/webp"
      : "image/jpeg";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`Karatina API listening on http://127.0.0.1:${PORT}`);
});

/**
 * After registration closes, pair **confirmed** players into fixtures without
 * waiting for someone to open the site. Runs on startup and on an interval.
 * (Render free tier sleeps; first request after wake still runs loadDbWithFixtures.)
 */
function tickFixturesAfterDeadline() {
  try {
    loadDbWithFixtures();
  } catch (e) {
    console.error("[fixtures] deadline tick failed:", e);
  }
}

const deadlineTickMs = Number(process.env.DEADLINE_FIXTURE_TICK_MS) || 60_000;
tickFixturesAfterDeadline();
setInterval(tickFixturesAfterDeadline, deadlineTickMs);
