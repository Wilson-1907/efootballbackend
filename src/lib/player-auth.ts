import crypto from "crypto";
import type { PlayerRecord } from "./db.js";

export const PLAYER_COOKIE = "player_session";

function secretKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function toB64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64Url(v: string): Buffer | null {
  try {
    const s = v.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s + pad, "base64");
  } catch {
    return null;
  }
}

export function hashPassword(password: string, secret: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, Buffer.concat([salt, secretKey(secret)]), 64);
  return `${toB64Url(salt)}.${toB64Url(key)}`;
}

export function verifyPassword(
  password: string,
  storedHash: string | null,
  secret: string,
): boolean {
  if (!storedHash) return false;
  const [saltPart, keyPart] = storedHash.split(".");
  if (!saltPart || !keyPart) return false;
  const salt = fromB64Url(saltPart);
  const expected = fromB64Url(keyPart);
  if (!salt || !expected) return false;
  const got = crypto.scryptSync(password, Buffer.concat([salt, secretKey(secret)]), 64);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function sessionSig(playerId: string, email: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${playerId}|${email.toLowerCase()}`)
    .digest("hex");
}

export function createPlayerSessionToken(
  player: Pick<PlayerRecord, "id" | "email">,
  secret: string,
): string {
  return `${player.id}.${sessionSig(player.id, player.email, secret)}`;
}

export function resolvePlayerFromToken(
  token: string | undefined,
  players: PlayerRecord[],
  secret: string,
): PlayerRecord | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const playerId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!playerId || !sig) return null;
  const player = players.find((p) => p.id === playerId);
  if (!player) return null;
  const expected = sessionSig(player.id, player.email, secret);
  return sig === expected ? player : null;
}
