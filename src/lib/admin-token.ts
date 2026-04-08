/**
 * Session token for admin cookie — Web Crypto (Edge-compatible token shape).
 */
const MESSAGE = "karatina-admin-session-v1";

export async function computeAdminSessionToken(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(MESSAGE));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const ADMIN_COOKIE = "karatina_admin";
