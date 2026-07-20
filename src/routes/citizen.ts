import { Router, Request, Response } from 'express';
import { requireCitizen, getSessionCitizenId } from '../middleware/requireAuth';
import { supabaseAdmin } from '../supabase';
import { auditLog } from '../services/audit';
import { classifyEmergencyMessage } from '../services/groq';

const router = Router();

// All citizen routes require authentication
router.use(requireCitizen);

/**
 * GET /api/citizen/profile
 * Returns only the authenticated citizen's own profile.
 * NEVER returns access_token.
 * NEVER accepts citizen_id from request — always derives from session.
 */
router.get('/profile', async (req: Request, res: Response): Promise<void> => {
  // SECURITY: Citizen ID comes ONLY from session, never from request params
  const citizenId = getSessionCitizenId(req);

  const { data, error } = await supabaseAdmin
    .from('citizens')
    .select('id, name, status, risk_score, latitude, longitude, children_count, elderly_count, mobility_issues')
    .eq('id', citizenId)
    .maybeSingle();

  if (error || !data) {
    res.status(404).json({ error: 'Citizen not found.' });
    return;
  }

  res.json({ citizen: data });
});

/**
 * GET /api/citizen/messages
 * Returns messages for the authenticated citizen only.
 * Backend ignores any citizen_id or id parameters in the request.
 */
router.get('/messages', async (req: Request, res: Response): Promise<void> => {
  // SECURITY: Always uses session citizen_id — ignores any supplied params
  const citizenId = getSessionCitizenId(req);

  if (!citizenId) {
    res.status(401).json({ error: 'Citizen session invalid.' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('id, citizen_id, sender, message, created_at')
    .eq('citizen_id', citizenId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[GET /api/citizen/messages Error]:', error);
    res.json({ messages: [] });
    return;
  }

  const formatted = (data || []).map(m => ({
    id: m.id,
    citizen_id: m.citizen_id,
    sender: m.sender,
    sender_type: m.sender,
    message: m.message,
    created_at: m.created_at
  }));

  res.json({ messages: formatted });
});

/**
 * POST /api/citizen/messages
 * Sends a message from the authenticated citizen.
 * Backend automatically sets citizen_id and sender = CITIZEN.
 */
router.post('/messages', async (req: Request, res: Response): Promise<void> => {
  const citizenId = getSessionCitizenId(req);
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message text is required.' });
    return;
  }

  if (message.length > 2000) {
    res.status(400).json({ error: 'Message too long. Maximum 2000 characters.' });
    return;
  }

  const messageText = message.trim();

  // Insert message into chat_messages
  const { data: inserted, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      citizen_id: citizenId,
      sender: 'CITIZEN',
      message: messageText,
    })
    .select('id, citizen_id, sender, message, created_at')
    .single();

  if (error || !inserted) {
    console.error('[POST /api/citizen/messages Error]:', error);
    res.status(500).json({ error: 'Failed to send message.' });
    return;
  }

  await auditLog('CITIZEN_MESSAGE_SENT', 'CITIZEN', String(citizenId));

  // Optionally classify with Groq in background — non-blocking
  classifyEmergencyMessage(messageText).then(async (classification) => {
    if (classification) {
      if ((classification.urgency === 'HIGH' || classification.urgency === 'CRITICAL') &&
          classification.intent !== 'SAFE') {
        await supabaseAdmin
          .from('citizens')
          .update({ status: 'URGENT' })
          .eq('id', citizenId);
      }
    }
  }).catch(() => {});

  res.status(201).json({ 
    message: {
      ...inserted,
      sender_type: inserted.sender
    } 
  });
});

/**
 * POST /api/citizen/status
 * Updates the authenticated citizen's emergency status.
 * Also records a status history entry.
 */
router.post('/status', async (req: Request, res: Response): Promise<void> => {
  const citizenId = getSessionCitizenId(req);
  const { action, notes } = req.body;

  const validActions = ['SAFE', 'HELP', 'MEDICAL', 'EVACUATION'];
  if (!action || !validActions.includes(action)) {
    res.status(400).json({ error: 'Invalid action. Must be one of: SAFE, HELP, MEDICAL, EVACUATION' });
    return;
  }

  // Determine new status and category
  const newStatus = action === 'SAFE' ? 'SAFE' : 'URGENT';
  const category = action === 'MEDICAL' ? 'MEDICAL' :
                   action === 'EVACUATION' ? 'EVACUATION' :
                   action === 'HELP' ? 'GENERAL' : undefined;

  // Get current status for history
  const { data: current } = await supabaseAdmin
    .from('citizens')
    .select('status')
    .eq('id', citizenId)
    .maybeSingle();

  const previousStatus = current?.status;

  // Update citizen status
  const { error: updateError } = await supabaseAdmin
    .from('citizens')
    .update({ status: newStatus })
    .eq('id', citizenId);

  if (updateError) {
    res.status(500).json({ error: 'Failed to update status.' });
    return;
  }

  // Record status history
  await supabaseAdmin.from('citizen_status_history').insert({
    citizen_id: citizenId,
    previous_status: previousStatus,
    new_status: newStatus,
    category,
    source: 'CITIZEN',
    metadata: { notes: notes || null, action },
  });

  // Insert status alert into chat_messages so it appears in Admin Live Dispatch Chat
  const actionLabel = {
    SAFE: "I'm Safe / Secure",
    HELP: "Need Assistance",
    MEDICAL: "Family Needs Help",
    EVACUATION: "Evacuating Zone",
  }[action as 'SAFE' | 'HELP' | 'MEDICAL' | 'EVACUATION'] || action;

  const alertMessage = `🚨 [EMERGENCY ALERT] ${actionLabel}${notes && notes.trim() ? `\nNotes: "${notes.trim()}"` : ''}`;

  await supabaseAdmin.from('chat_messages').insert({
    citizen_id: citizenId,
    sender: 'CITIZEN',
    message: alertMessage,
  });

  await auditLog('STATUS_CHANGED', 'CITIZEN', String(citizenId), {
    previousStatus,
    newStatus,
    action,
    category,
  });

  res.json({ success: true, status: newStatus, category });
});

export default router;
