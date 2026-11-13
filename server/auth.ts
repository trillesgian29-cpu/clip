import 'dotenv/config';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Single-owner authentication state
let updatedPasscodeOverride: string | null = null;
function getConfiguredPasscode(): string {
  return updatedPasscodeOverride ?? (process.env.OWNER_PASSCODE || 'clipgenius-owner-2026');
}
function getSessionSecret(): string {
  return process.env.SESSION_SECRET || 'clipgenius-local-session-secret-key';
}
const revokedTokens = new Set<string>();

function signPayload(payloadB64: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('hex');
}

// Generate an HMAC-signed session token valid for 24 hours
export function createSessionToken(): string {
  const payload = JSON.stringify({
    role: 'owner',
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + 24 * 60 * 60 * 1000,
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = signPayload(payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token?: string): boolean {
  if (!token || revokedTokens.has(token)) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return false;

  const expectedSig = signPayload(payloadB64);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return parsed?.role === 'owner' && typeof parsed?.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function revokeSessionToken(token?: string): void {
  if (token) {
    revokedTokens.add(token);
  }
}

export function verifyPasscode(passcode: string): boolean {
  return passcode.trim() === getConfiguredPasscode().trim();
}

export function updatePasscode(oldPasscode: string, newPasscode: string): boolean {
  if (verifyPasscode(oldPasscode) && newPasscode && newPasscode.length >= 6) {
    updatedPasscodeOverride = newPasscode;
    return true;
  }
  return false;
}

// Express middleware to ensure only the authenticated owner can access sensitive endpoints
export function requireOwnerAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.cookies?.session_token as string);

  if (!token || !verifySessionToken(token)) {
    return res.status(401).json({
      error: 'Unauthorized: Single-owner authentication required',
      code: 'AUTH_REQUIRED'
    });
  }

  next();
}

export function getOwnerStatus(req: Request): boolean {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.cookies?.session_token as string);
  return verifySessionToken(token);
}
