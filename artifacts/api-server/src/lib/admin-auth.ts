import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Request } from "express";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const ADMIN_AUTH_FILE = path.join(DATA_DIR, "sidebet_admin_auth.json");

interface StoredAdminHash {
  salt: string;
  hash: string;
  claimedAt: string;
}

const activeAdminSessions = new Map<string, number>(); // token -> expiresAtMs
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function getEnvPasscode(): string {
  return (process.env.ADMIN_PASSCODE || "").trim();
}

function loadClaimedHash(): StoredAdminHash | null {
  try {
    if (fs.existsSync(ADMIN_AUTH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ADMIN_AUTH_FILE, "utf-8"));
      if (parsed?.salt && parsed?.hash) {
        return parsed as StoredAdminHash;
      }
    }
  } catch (err) {
    console.warn("Failed to load admin auth file:", err);
  }
  return null;
}

function hashPasscode(passcode: string, salt: string): string {
  return crypto.scryptSync(passcode, salt, 64).toString("hex");
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function getAdminAuthStatus(): {
  configured: boolean;
  needsBootstrap: boolean;
  envManaged: boolean;
} {
  const envPass = getEnvPasscode();
  if (envPass.length > 0) {
    return { configured: true, needsBootstrap: false, envManaged: true };
  }
  const claimed = loadClaimedHash();
  return {
    configured: Boolean(claimed),
    needsBootstrap: !claimed,
    envManaged: false,
  };
}

export function bootstrapAdminPasscode(passcode: string): { ok: boolean; error?: string } {
  if (getEnvPasscode().length > 0) {
    return { ok: false, error: "Admin passcode is already managed by server environment." };
  }
  if (loadClaimedHash()) {
    return { ok: false, error: "Admin passcode has already been claimed." };
  }
  const trimmed = passcode.trim();
  if (trimmed.length < 6) {
    return { ok: false, error: "Admin passcode must be at least 6 characters." };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPasscode(trimmed, salt);
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(
    ADMIN_AUTH_FILE,
    JSON.stringify({ salt, hash, claimedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  return { ok: true };
}

export function verifyAdminPasscode(passcode: string): boolean {
  const candidate = passcode.trim();
  if (!candidate) return false;

  const envPass = getEnvPasscode();
  if (envPass.length > 0) {
    return timingSafeTextEqual(candidate, envPass);
  }

  const claimed = loadClaimedHash();
  if (!claimed) return false;
  const candidateHash = hashPasscode(candidate, claimed.salt);
  return timingSafeTextEqual(candidateHash, claimed.hash);
}

export function issueAdminSessionToken(): string {
  const now = Date.now();
  // Prune expired sessions
  for (const [tok, exp] of activeAdminSessions.entries()) {
    if (exp <= now) activeAdminSessions.delete(tok);
  }
  const token = crypto.randomBytes(32).toString("hex");
  activeAdminSessions.set(token, now + SESSION_TTL_MS);
  return token;
}

export function verifyAdminRequest(req: Request): boolean {
  const rawToken = (req.headers["x-admin-token"] as string | undefined)?.trim();
  if (rawToken) {
    const exp = activeAdminSessions.get(rawToken);
    if (exp && exp > Date.now()) {
      return true;
    }
    if (exp) activeAdminSessions.delete(rawToken);
  }

  // Also allow direct server-to-server passcode header for CLI/Render scripts
  const headerPass = (req.headers["x-admin-passcode"] as string | undefined)?.trim();
  if (headerPass && verifyAdminPasscode(headerPass)) {
    return true;
  }

  return false;
}
