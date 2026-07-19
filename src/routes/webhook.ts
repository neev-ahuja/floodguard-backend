import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { config } from '../config';
import { auditLog } from '../services/audit';

const router = Router();

// Middleware to validate n8n webhook secret
function validateWebhookSecret(req: Request, res: Response, next: () => void): void {
  const secret = req.headers['x-n8n-webhook-secret'];
  if (!config.n8nWebhookSecret || secret !== config.n8nWebhookSecret) {
    auditLog('WEBHOOK_REJECTED', 'N8N', undefined, { message: 'Invalid or missing webhook secret header' });
    res.status(401).json({ error: 'Unauthorized. Invalid webhook secret.' });
    return;
  }
  next();
}

// Apply validation middleware to all webhook routes
router.use(validateWebhookSecret);

/**
 * POST /api/webhook/incident-alert
 * Triggered by n8n when a disaster incident is created/active.
 * Receives: { latitude: number, longitude: number, radiusMeters: number, alertMessage: string }
 * Queries citizens inside the radius, returns their names, emails, and existing access_tokens for Brevo.
 */
router.post('/incident-alert', async (req: Request, res: Response): Promise<void> => {
  const { latitude, longitude, radiusMeters, alertMessage } = req.body;

  if (!latitude || !longitude || !radiusMeters) {
    res.status(400).json({ error: 'latitude, longitude, and radiusMeters are required.' });
    return;
  }

  // Find citizens within radius using PostGIS distance query via Supabase RPC or raw query if supported
  // Since we might not have a custom RPC configured yet, we can do a standard distance calculation in SQL or a fallback.
  // We can call a database function 'get_citizens_in_radius' or fallback to bounding box calculation.
  // Let's call RPC first, and if not exists, fallback to standard query.
  const { data, error } = await supabaseAdmin.rpc('get_citizens_in_radius', {
    lat_val: latitude,
    lng_val: longitude,
    radius_meters: radiusMeters
  });

  let affectedCitizens = data;

  if (error) {
    console.warn('[WEBHOOK] get_citizens_in_radius RPC failed, falling back to math-based bounding box query...', error.message);
    
    // Fallback math bounding box (approximate)
    // 1 degree latitude ~ 111,000 meters
    // 1 degree longitude ~ 111,000 * cos(lat) meters
    const degLat = radiusMeters / 111000;
    const degLng = radiusMeters / (111000 * Math.cos(latitude * Math.PI / 180));

    const { data: fallbackData, error: fallbackError } = await supabaseAdmin
      .from('citizens')
      .select('id, name, email, latitude, longitude, status, access_token')
      .gte('latitude', latitude - degLat)
      .lte('latitude', latitude + degLat)
      .gte('longitude', longitude - degLng)
      .lte('longitude', longitude + degLng);

    if (fallbackError) {
      res.status(500).json({ error: 'Failed to query database for affected citizens.' });
      return;
    }
    affectedCitizens = fallbackData;
  }

  // Filter or process citizens list
  const results = (affectedCitizens || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    access_token: c.access_token, // Safe because this endpoint is protected by n8n webhook secret
    link: `${config.publicAppUrl}/respond?token=${c.access_token}`
  }));

  // Update their status to ALERTED in batch
  if (results.length > 0) {
    const ids = results.map((r: any) => r.id);
    await supabaseAdmin
      .from('citizens')
      .update({ status: 'ALERTED' })
      .in('id', ids);

    // Create status history entries
    for (const c of results) {
      await supabaseAdmin.from('citizen_status_history').insert({
        citizen_id: c.id,
        previous_status: 'SAFE', // assume default or transition
        new_status: 'ALERTED',
        source: 'SYSTEM',
        metadata: { trigger: 'n8n_incident_alert', alertMessage }
      });
    }
  }

  await auditLog('WEBHOOK_RECEIVED', 'N8N', 'incident-alert', {
    citizensCount: results.length,
    radiusMeters,
    alertMessage
  });

  res.json({
    success: true,
    alertMessage,
    affectedCount: results.length,
    citizens: results
  });
});

export default router;
