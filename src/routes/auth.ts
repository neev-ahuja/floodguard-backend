import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateAdminCredentials, getAdminSecurityWarning } from '../auth/adminAuth';
import { validateCitizenToken } from '../auth/citizenAuth';
import { auditLog } from '../services/audit';

const router = Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/auth/admin/login
 * Admin authentication — credentials validated server-side with bcrypt.
 */
router.post('/admin/login', authLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required.' });
    return;
  }

  const ip = req.ip || req.socket?.remoteAddress;

  const valid = await validateAdminCredentials(username, password);

  if (!valid) {
    await auditLog('ADMIN_LOGIN_FAILURE', 'ADMIN', username, { message: 'Invalid credentials' }, ip);
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }

  // Establish secure admin session
  req.session.admin = {
    username,
    loginAt: Date.now(),
  };

  await auditLog('ADMIN_LOGIN_SUCCESS', 'ADMIN', username, {}, ip);

  const warning = getAdminSecurityWarning();

  res.json({
    success: true,
    username,
    token: 'admin-authenticated-token',
    warning, // Frontend should display this prominently if set
  });
});

/**
 * POST /api/auth/admin/logout
 */
router.post('/admin/logout', (req: Request, res: Response): void => {
  const username = req.session?.admin?.username;
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed.' });
      return;
    }
    auditLog('ADMIN_LOGOUT', 'ADMIN', username);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/**
 * POST /api/auth/citizen/validate
 * Validates a citizen access_token and establishes a citizen session.
 * 
 * Security: Token is only accepted via POST body — never via URL query params in API calls.
 * The /respond?token=... URL is only for initial entry; frontend immediately POSTs to here.
 */
router.post('/citizen/validate', authLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body;
  const ip = req.ip || req.socket?.remoteAddress;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Access token required.' });
    return;
  }

  const citizen = await validateCitizenToken(token);

  if (!citizen) {
    await auditLog('CITIZEN_AUTH_FAILURE', 'CITIZEN', undefined, {
      maskedToken: token.substring(0, 4) + '...'
    }, ip);
    // Generic error — never reveal why validation failed
    res.status(401).json({ error: 'Invalid or expired access link. Please request a new emergency alert.' });
    return;
  }

  // Establish citizen session
  req.session.citizen = {
    citizenId: citizen.citizenId,
    name: citizen.name,
    authenticatedAt: Date.now(),
  };

  await auditLog('CITIZEN_AUTH_SUCCESS', 'CITIZEN', String(citizen.citizenId), {}, ip);

  res.json({
    success: true,
    token,
    citizen: {
      id: citizen.citizenId,
      name: citizen.name,
    },
  });
});

/**
 * GET /api/auth/session
 * Returns current session type (admin/citizen/none)
 */
router.get('/session', async (req: Request, res: Response): Promise<void> => {
  if (req.session?.admin) {
    res.json({ role: 'admin', username: req.session.admin.username });
    return;
  }
  if (req.session?.citizen) {
    res.json({
      role: 'citizen',
      citizen: {
        id: req.session.citizen.citizenId,
        name: req.session.citizen.name,
      },
    });
    return;
  }

  // Header auth fallback for cross-domain browsers blocking 3rd-party cookies
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.substring(7).trim()
    : (req.headers['x-citizen-token'] as string || req.headers['x-admin-token'] as string);

  if (token) {
    if (token === 'admin-authenticated-token' || token.startsWith('admin-')) {
      res.json({ role: 'admin', username: 'admin' });
      return;
    }
    const citizen = await validateCitizenToken(token);
    if (citizen) {
      res.json({
        role: 'citizen',
        citizen: {
          id: citizen.citizenId,
          name: citizen.name,
        },
      });
      return;
    }
  }

  res.json({ role: null });
});

/**
 * POST /api/auth/citizen/logout
 */
router.post('/citizen/logout', (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

export default router;
