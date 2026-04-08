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
import { findValidatedMatch } from "./lib/result-ocr.js";
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
    paid: false as const,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };

  db = { ...db, players: [...db.players, player] };
  writeDb(db);

  res.json({
    ok: true,
    message:
      "Registration received. To be approved you must pay KSh 200 and then wait for verification.",
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
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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

  if (
    body.tournamentName === undefined &&
    body.registrationStartsAt === undefined &&
    body.registrationEndsAt === undefined &&
    body.tournamentStartsAt === undefined &&
    body.tournamentEndsAt === undefined &&
    body.matchDurationMinutes === undefined &&
    body.breakMinutes === undefined &&
    body.rulesMarkdown === undefined
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
  };
  try {
    body = req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const { matchId, homeScore, awayScore, scheduledAt, status } = body;
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
  let body: { playerId?: string; status?: string; paid?: boolean };
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
  const nextPaid = typeof body.paid === "boolean" ? body.paid : prev.paid;
  if (status === "confirmed" && !nextPaid) {
    res.status(400).json({
      error:
        "Player must be marked as paid (KSh 200) before confirmation.",
    });
    return;
  }
  players[idx] = {
    ...prev,
    paid: nextPaid,
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
        note: "No matching scheduled fixture: check Konami names, score format, and match time.",
      };
      db = { ...db, submissions: [...db.submissions, sub] };
      writeDb(db);
      res.status(422).json({
        error:
          "Could not auto-validate: ensure the screenshot shows both Konami names as registered, the score (e.g. 2-1), and that this match was scheduled around this time.",
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
