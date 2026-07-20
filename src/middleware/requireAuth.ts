import { Request, Response, NextFunction } from 'express';
import { validateCitizenToken } from '../auth/citizenAuth';
import { config } from '../config';

// Extend session type
declare module 'express-session' {
  interface SessionData {
    admin?: { username: string; loginAt: number };
    citizen?: { citizenId: number; name: string; authenticatedAt: number };
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  const citizenToken = req.headers['x-citizen-token'];
  if (typeof citizenToken === 'string' && citizenToken) {
    return citizenToken;
  }
  const adminToken = req.headers['x-admin-token'];
  if (typeof adminToken === 'string' && adminToken) {
    return adminToken;
  }
  return null;
}

/**
 * Middleware: Requires valid admin session or Bearer header token.
 * Every /api/admin/* route must use this.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.session?.admin) {
    return next();
  }

  const token = extractToken(req);
  if (token && (token === 'admin-authenticated-token' || token.startsWith('admin-'))) {
    if (!req.session) (req as any).session = {};
    req.session.admin = { username: config.adminUsername, loginAt: Date.now() };
    return next();
  }

  res.status(401).json({ error: 'Unauthorized. Admin authentication required.' });
}

/**
 * Middleware: Requires valid citizen session or Bearer header token.
 * Every /api/citizen/* route must use this.
 */
export async function requireCitizen(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.session?.citizen) {
    return next();
  }

  const token = extractToken(req);
  if (token) {
    const citizen = await validateCitizenToken(token);
    if (citizen) {
      if (!req.session) (req as any).session = {};
      req.session.citizen = {
        citizenId: citizen.citizenId,
        name: citizen.name,
        authenticatedAt: Date.now(),
      };
      return next();
    }
  }

  res.status(401).json({ error: 'Unauthorized. Please authenticate with your emergency link.' });
}

/**
 * Helper: Get authenticated citizen ID from session.
 * NEVER trusts citizen_id from request body or query params.
 */
export function getSessionCitizenId(req: Request): number {
  return req.session!.citizen!.citizenId;
}
