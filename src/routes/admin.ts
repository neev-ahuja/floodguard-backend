import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/requireAuth';
import { supabaseAdmin } from '../supabase';
import { auditLog } from '../services/audit';

const router = Router();

// All admin routes require admin authentication
router.use(requireAdmin);

/**
 * GET /api/admin/citizens
 * Returns all citizens sorted by priority (URGENT first, then by risk_score).
 * NEVER returns access_token field.
 */
router.get('/citizens', async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from('citizens')
    .select('id, name, email, latitude, longitude, children_count, elderly_count, mobility_issues, status, risk_score')
    .order('risk_score', { ascending: false });

  if (error) {
    res.status(500).json({ error: 'Failed to fetch citizens.' });
    return;
  }

  // Sort by priority: URGENT first, then ALERTED, then SAFE, then by risk_score
  const statusOrder: Record<string, number> = { URGENT: 0, ALERTED: 1, SAFE: 2, RESOLVED: 3 };
  const sorted = (data || []).sort((a, b) => {
    const aOrder = statusOrder[a.status?.toUpperCase()] ?? 99;
    const bOrder = statusOrder[b.status?.toUpperCase()] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (b.risk_score || 0) - (a.risk_score || 0);
  });

  res.json({ citizens: sorted });
});

/**
 * GET /api/admin/citizens/:citizenId/messages
 * Returns all messages for a specific citizen.
 * Admin-only access.
 */
router.get('/citizens/:citizenId/messages', async (req: Request, res: Response): Promise<void> => {
  const citizenId = parseInt(req.params.citizenId as string);
  if (isNaN(citizenId)) {
    res.status(400).json({ error: 'Invalid citizen ID.' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('emergency_messages')
    .select('id, citizen_id, sender_type, message, message_type, created_at, read_at, metadata')
    .eq('citizen_id', citizenId)
    .order('created_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: 'Failed to fetch messages.' });
    return;
  }

  res.json({ messages: data || [] });
});

/**
 * POST /api/admin/citizens/:citizenId/messages
 * Sends an admin reply to a specific citizen.
 * Backend sets sender_type = ADMIN.
 */
router.post('/citizens/:citizenId/messages', async (req: Request, res: Response): Promise<void> => {
  const citizenId = parseInt(req.params.citizenId as string);
  if (isNaN(citizenId)) {
    res.status(400).json({ error: 'Invalid citizen ID.' });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message text is required.' });
    return;
  }

  const adminUsername = req.session?.admin?.username;

  const { data: inserted, error } = await supabaseAdmin
    .from('emergency_messages')
    .insert({
      citizen_id: citizenId,
      sender_type: 'ADMIN',   // Always set by backend — never from frontend
      message: message.trim(),
      message_type: 'TEXT',
      metadata: { admin: adminUsername },
    })
    .select('id, sender_type, message, message_type, created_at')
    .single();

  if (error || !inserted) {
    res.status(500).json({ error: 'Failed to send message.' });
    return;
  }

  await auditLog('ADMIN_MESSAGE_SENT', 'ADMIN', adminUsername, { citizenId });

  res.status(201).json({ message: inserted });
});

/**
 * PATCH /api/admin/citizens/:citizenId/status
 * Updates a citizen's status. Admin-only.
 */
router.patch('/citizens/:citizenId/status', async (req: Request, res: Response): Promise<void> => {
  const citizenId = parseInt(req.params.citizenId as string);
  if (isNaN(citizenId)) {
    res.status(400).json({ error: 'Invalid citizen ID.' });
    return;
  }

  const { status } = req.body;
  const validStatuses = ['SAFE', 'ALERTED', 'URGENT', 'RESOLVED'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: 'Invalid status.' });
    return;
  }

  // Get current status
  const { data: current } = await supabaseAdmin
    .from('citizens')
    .select('status')
    .eq('id', citizenId)
    .maybeSingle();

  const { error } = await supabaseAdmin
    .from('citizens')
    .update({ status })
    .eq('id', citizenId);

  if (error) {
    res.status(500).json({ error: 'Failed to update status.' });
    return;
  }

  // Record status history
  await supabaseAdmin.from('citizen_status_history').insert({
    citizen_id: citizenId,
    previous_status: current?.status,
    new_status: status,
    source: 'ADMIN',
    metadata: { admin: req.session?.admin?.username },
  });

  await auditLog('STATUS_CHANGED', 'ADMIN', req.session?.admin?.username, {
    citizenId,
    previousStatus: current?.status,
    newStatus: status,
  });

  res.json({ success: true, status });
});

/**
 * GET /api/admin/dashboard
 * Returns aggregate stats for the admin dashboard.
 */
router.get('/dashboard', async (_req: Request, res: Response): Promise<void> => {
  const { data: citizens, error } = await supabaseAdmin
    .from('citizens')
    .select('id, status, risk_score, mobility_issues, children_count, elderly_count');

  if (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard data.' });
    return;
  }

  const all = citizens || [];

  const stats = {
    total: all.length,
    safe: all.filter(c => c.status?.toUpperCase() === 'SAFE').length,
    alerted: all.filter(c => c.status?.toUpperCase() === 'ALERTED').length,
    urgent: all.filter(c => c.status?.toUpperCase() === 'URGENT').length,
    resolved: all.filter(c => c.status?.toUpperCase() === 'RESOLVED').length,
    highRisk: all.filter(c => (c.risk_score || 0) >= 70).length,
    mobilityIssues: all.filter(c => c.mobility_issues).length,
    withChildren: all.filter(c => (c.children_count || 0) > 0).length,
    withElderly: all.filter(c => (c.elderly_count || 0) > 0).length,
  };

  // Count unread messages
  const { count: unreadCount } = await supabaseAdmin
    .from('emergency_messages')
    .select('*', { count: 'exact', head: true })
    .eq('sender_type', 'CITIZEN')
    .is('read_at', null);

  // Count active conversations (citizens with at least one message)
  const { data: activeConvos } = await supabaseAdmin
    .from('emergency_messages')
    .select('citizen_id')
    .eq('sender_type', 'CITIZEN');

  const uniqueActiveConvos = new Set(activeConvos?.map(m => m.citizen_id) || []).size;

  res.json({
    stats: {
      ...stats,
      unreadMessages: unreadCount || 0,
      activeConversations: uniqueActiveConvos,
    },
  });
});

/**
 * GET /api/admin/audit-logs
 * Returns recent audit logs.
 */
router.get('/audit-logs', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const { data, error } = await supabaseAdmin
    .from('audit_logs')
    .select('id, event_type, actor_type, actor_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch audit logs.' });
    return;
  }

  res.json({ logs: data || [] });
});

export default router;
