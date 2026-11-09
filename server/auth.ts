import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Single-owner authentication state
let currentOwnerPasscode = process.env.OWNER_PASSCODE || 'clipgenius-owner-2026';
const validTokens = new Set<string>();

// Generate a random session token
export function createSessionToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.add(token);
  return token;
}

export function verifySessionToken(token?: string): boolean {
  if (!token) return false;
  return validTokens.has(token);
}

export function revokeSessionToken(token?: string): void {
  if (token) {
    validTokens.delete(token);
  }
}

export function verifyPasscode(passcode: string): boolean {
  return passcode.trim() === currentOwnerPasscode.trim();
}

export function updatePasscode(oldPasscode: string, newPasscode: string): boolean {
  if (verifyPasscode(oldPasscode) && newPasscode && newPasscode.length >= 6) {
    currentOwnerPasscode = newPasscode;
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
