import { Request, Response, NextFunction } from 'express';

// Extend session type
declare module 'express-session' {
  interface SessionData {
    admin?: { username: string; loginAt: number };
    citizen?: { citizenId: number; name: string; authenticatedAt: number };
  }
}

/**
 * Middleware: Requires valid admin session.
 * Every /api/admin/* route must use this.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.admin) {
    res.status(401).json({ error: 'Unauthorized. Admin authentication required.' });
    return;
  }
  next();
}

/**
 * Middleware: Requires valid citizen session.
 * Every /api/citizen/* route must use this.
 */
export function requireCitizen(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.citizen) {
    res.status(401).json({ error: 'Unauthorized. Please authenticate with your emergency link.' });
    return;
  }
  next();
}

/**
 * Helper: Get authenticated citizen ID from session.
 * NEVER trusts citizen_id from request body or query params.
 */
export function getSessionCitizenId(req: Request): number {
  return req.session!.citizen!.citizenId;
}
