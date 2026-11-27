// Accounts: "Sign in with Google" + each user's saved places in Cloudflare D1 (binding DB).
// The app sends Google's ID token once; it is checked here (signature, audience, expiry) and swapped for our own session
// token, which the app keeps and sends as "Authorization: Bearer ...". Only Google's account number (sub) is stored,
// never the email or name. Tables are created on first use.

export const CLIENT_ID = "988770051891-dr9ava1do6jdn13j4tfeodltpj46dst0.apps.googleusercontent.com";
const SESSION_DAYS = 180;
const MAX_DOC = 300 * 1024; // bytes of saved places per user
const ALLOWED_ORIGINS = ["https://vanlife-map.annajagiello.workers.dev", "http://localhost:8000", "http://localhost"];

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, created INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, sub TEXT NOT NULL, expires INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS docs (sub TEXT PRIMARY KEY, doc TEXT NOT NULL, updated INTEGER NOT NULL)"),
  ]);
  tablesReady = true;
}

function cors(request) {
  const origin = request.headers.get("Origin");
  return ALLOWED_ORIGINS.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE", Vary: "Origin" }
    : {};
}
const json = (request, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(request) } });

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function sha256(text) { return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }

// Google's signing keys, kept for an hour.
let jwks = null, jwksAt = 0;
async function googleKey(kid) {
  if (!jwks || Date.now() - jwksAt > 3600 * 1000 || !jwks.find((k) => k.kid === kid)) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    jwks = (await r.json()).keys; jwksAt = Date.now();
  }
  const jwk = jwks.find((k) => k.kid === kid);
  return jwk && crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}
async function verifyIdToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  if (header.alg !== "RS256") return null;
  const key = await googleKey(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  if (claims.aud !== CLIENT_ID) return null;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return null;
  if (!(claims.exp * 1000 > Date.now()) || !claims.sub) return null;
  return claims;
}

async function sessionSub(request, db) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  const row = await db.prepare("SELECT sub, expires FROM sessions WHERE token_hash = ?").bind(await sha256(m[1])).first();
  return row && row.expires > Date.now() ? row.sub : null;
}

export async function handleAccount(request, env, path) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (!env.DB) return json(request, { error: "accounts are not set up yet" }, 503);
  const db = env.DB;
  await ensureTables(db);

  if (path === "/api/login" && request.method === "POST") {
    const { credential } = await request.json().catch(() => ({}));
    const claims = await verifyIdToken(credential).catch(() => null);
    if (!claims) return json(request, { error: "sign-in could not be verified" }, 401);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (sub, created) VALUES (?, ?)").bind(claims.sub, Date.now()),
      db.prepare("INSERT INTO sessions (token_hash, sub, expires) VALUES (?, ?, ?)").bind(await sha256(token), claims.sub, Date.now() + SESSION_DAYS * 864e5),
    ]);
    // The first name is only sent back for the "Signed in as …" line; it is not stored.
    return json(request, { session: token, name: claims.given_name || claims.name || "" });
  }

  const sub = await sessionSub(request, db);
  if (!sub) return json(request, { error: "not signed in" }, 401);

  if (path === "/api/data" && request.method === "GET") {
    const row = await db.prepare("SELECT doc, updated FROM docs WHERE sub = ?").bind(sub).first();
    return json(request, row ? { doc: JSON.parse(row.doc), updated: row.updated } : { doc: null, updated: 0 });
  }
  if (path === "/api/data" && request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_DOC) return json(request, { error: "too much data" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json(request, { error: "bad data" }, 400); }
    const updated = Number(body.updated) || Date.now();
    await db.prepare("INSERT INTO docs (sub, doc, updated) VALUES (?, ?, ?) ON CONFLICT(sub) DO UPDATE SET doc = excluded.doc, updated = excluded.updated")
      .bind(sub, JSON.stringify(body.doc ?? {}), updated).run();
    return json(request, { ok: true, updated });
  }
  if (path === "/api/logout" && request.method === "POST") {
    const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(m[1])).run();
    return json(request, { ok: true });
  }
  if (path === "/api/account" && request.method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM docs WHERE sub = ?").bind(sub),
      db.prepare("DELETE FROM sessions WHERE sub = ?").bind(sub),
      db.prepare("DELETE FROM users WHERE sub = ?").bind(sub),
    ]);
    return json(request, { ok: true });
  }
  return json(request, { error: "not found" }, 404);
}
