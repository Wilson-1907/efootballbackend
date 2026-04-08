import type { NextFunction, Request, Response } from "express";
import { ADMIN_COOKIE, computeAdminSessionToken } from "./lib/admin-token.js";

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

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    try {
      const secret = process.env.SESSION_SECRET ?? "dev-change-me";
      const expected = await computeAdminSessionToken(secret);
      const val = getCookie(req.headers.cookie, ADMIN_COOKIE);
      if (val !== expected) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: "Auth error" });
    }
  })();
}
