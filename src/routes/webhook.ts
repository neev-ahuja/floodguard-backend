import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { config, isProduction } from '../config';
import { auditLog } from '../services/audit';

const router = Router();

// Middleware to validate n8n webhook secret
function validateWebhookSecret(req: Request, res: Response, next: () => void): void {
  const secretHeader = req.headers['x-n8n-webhook-secret'];
  const secretQuery = req.query.secret;
  const providedSecret = secretHeader || secretQuery;

  // If secret is configured and provided, validate it
  if (config.n8nWebhookSecret && providedSecret) {
    if (providedSecret !== config.n8nWebhookSecret) {
      auditLog('WEBHOOK_REJECTED', 'N8N', undefined, { message: 'Invalid webhook secret provided' });
      res.status(401).json({ error: 'Unauthorized. Invalid webhook secret.' });
      return;
    }
  } else if (config.n8nWebhookSecret && !providedSecret && isProduction()) {
    // Enforce in production
    auditLog('WEBHOOK_REJECTED', 'N8N', undefined, { message: 'Missing required webhook secret header in production' });
    res.status(401).json({ error: 'Unauthorized. Missing webhook secret.' });
    return;
  }

  next();
}

// Apply validation middleware to all webhook routes
router.use(validateWebhookSecret);

/**
 * GET /api/webhook/status
 * Returns webhook status and available endpoint URLs
 */
router.get('/status', (req: Request, res: Response): void => {
  res.json({
    status: 'ACTIVE',
    endpoints: {
      weather: `http://localhost:${config.port}/api/webhook/weather`,
      incident_alert: `http://localhost:${config.port}/api/webhook/incident-alert`,
      alert_manual: `http://localhost:${config.port}/api/webhook/alert-manual`
    },
    ngrok_endpoints: {
      weather: `https://mystified-encrypt-reheat.ngrok-free.dev/api/webhook/weather`,
      incident_alert: `https://mystified-encrypt-reheat.ngrok-free.dev/api/webhook/incident-alert`,
      alert_manual: `https://mystified-encrypt-reheat.ngrok-free.dev/webhook-test/alert-manual`
    },
    secret_configured: Boolean(config.n8nWebhookSecret)
  });
});

// Helper functions to clean n8n expression values (e.g. "=2026-07-20" or "=95")
function parseN8nValue(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  return str.startsWith('=') ? str.substring(1).trim() : str;
}

function parseN8nNumber(val: any, fallback = 0): number {
  if (val === null || val === undefined) return fallback;
  const cleaned = parseN8nValue(val);
  const num = parseFloat(cleaned);
  return isNaN(num) ? fallback : num;
}

// Shared Live Weather Telemetry State
export let liveWeatherStationState = {
  temp: 23.4,
  humidity: 92,
  rainfall: 48.0,
  windSpeed: 28.4,
  riverLevel: 6.85,
  waterRiseTrend: 'rising' as 'rising' | 'falling' | 'stable',
  lastUpdated: new Date().toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false }) + ' UTC',
  city: 'Chennai',
  alertStatus: 'NORMAL',
  isFloodRisk: false,
  severity: 'LOW',
  alertMessage: '',
  recommendedActions: [] as string[],
  weatherCode: 0,
  rainChancePercent: 0,
};

/**
 * GET /api/webhook/weather
 * Returns the latest weather station telemetry feed.
 */
router.get('/weather', (_req: Request, res: Response): void => {
  res.json(liveWeatherStationState);
});

/**
 * POST /api/webhook/weather
 * Ingests weather forecast data sent from n8n HTTP Request node.
 * Supports both flat payloads and nested n8n structures (weather_details, leading '=' strings, etc.).
 */
router.post('/weather', async (req: Request, res: Response): Promise<void> => {
  const body = req.body || {};
  const weatherDetails = body.weather_details || {};

  // Extract date
  const rawDate = body.date || weatherDetails.date;
  const recordDate = parseN8nValue(rawDate) || new Date().toISOString().split('T')[0];

  // Extract weather parameters from top-level or nested weather_details
  const precip = parseN8nNumber(body.precipitation_sum_mm ?? weatherDetails.precipitation_sum_mm, 0);
  const rainChance = parseN8nNumber(body.rain_chance_percent ?? weatherDetails.rain_chance_percent, 0);
  const maxTemp = parseN8nNumber(body.max_temp_c ?? weatherDetails.max_temp_c, 0);
  const minTemp = parseN8nNumber(body.min_temp_c ?? weatherDetails.min_temp_c, 0);
  const code = parseN8nNumber(body.weather_code ?? weatherDetails.weather_code, 0);

  // Extract n8n alert fields
  const city = parseN8nValue(body.city) || 'Chennai';
  const alertStatus = parseN8nValue(body.alert_status) || (precip > 30 || rainChance >= 70 ? 'CRITICAL_FLOOD_RISK' : 'NORMAL');
  const isFloodRisk = typeof body.is_flood_risk === 'boolean' ? body.is_flood_risk : (precip > 30 || rainChance >= 70);
  const severity = parseN8nValue(body.severity) || (isFloodRisk ? 'HIGH' : 'LOW');
  const alertMessage = parseN8nValue(body.alert_message);
  const recommendedActions = Array.isArray(body.recommended_actions) 
    ? body.recommended_actions.map((a: any) => parseN8nValue(a)).filter(Boolean)
    : [];

  const floodRiskLevel = isFloodRisk || precip > 30 || rainChance >= 70 ? 'HIGH' : (precip > 10 || rainChance >= 40) ? 'MODERATE' : 'LOW';

  const calcTemp = maxTemp > 0 ? (minTemp > 0 ? Math.round(((maxTemp + minTemp) / 2) * 10) / 10 : maxTemp) : 23.4;
  const calcHumidity = rainChance > 0 ? rainChance : 92;
  const calcRiverLevel = Math.round((5.0 + (precip / 10)) * 100) / 100;
  const calcTrend = precip > 30 ? 'rising' : precip > 10 ? 'stable' : 'falling';
  const calcWind = Math.round((15 + (precip * 0.3)) * 10) / 10;
  const nowUtc = new Date().toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false }) + ' UTC';

  liveWeatherStationState = {
    temp: calcTemp,
    humidity: calcHumidity,
    rainfall: precip,
    windSpeed: calcWind,
    riverLevel: calcRiverLevel,
    waterRiseTrend: calcTrend,
    lastUpdated: nowUtc,
    city,
    alertStatus,
    isFloodRisk,
    severity,
    alertMessage,
    recommendedActions,
    weatherCode: code,
    rainChancePercent: rainChance,
  };

  await auditLog('WEBHOOK_RECEIVED', 'N8N', 'weather-telemetry', {
    date: recordDate,
    maxTempC: maxTemp,
    minTempC: minTemp,
    precipitationSumMm: precip,
    rainChancePercent: rainChance,
    weatherCode: code,
    floodRiskLevel,
    city,
    alertStatus,
    severity
  });

  res.json({
    success: true,
    message: 'Weather forecast telemetry received successfully',
    live_weather: liveWeatherStationState,
    summary: {
      date: recordDate,
      city,
      alert_status: alertStatus,
      is_flood_risk: isFloodRisk,
      severity,
      max_temp_c: maxTemp,
      min_temp_c: minTemp,
      precipitation_sum_mm: precip,
      rain_chance_percent: rainChance,
      weather_code: code,
      flood_risk_level: floodRiskLevel,
      alert_message: alertMessage,
      recommended_actions: recommendedActions,
      received_at: new Date().toISOString()
    }
  });
});

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
  const { data, error } = await supabaseAdmin.rpc('get_citizens_in_radius', {
    lat_val: latitude,
    lng_val: longitude,
    radius_meters: radiusMeters
  });

  let affectedCitizens = data;

  if (error) {
    console.warn('[WEBHOOK] get_citizens_in_radius RPC failed, falling back to math-based bounding box query...', error.message);
    
    // Fallback math bounding box (approximate)
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

  const results = (affectedCitizens || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    access_token: c.access_token, // Safe because this endpoint is protected by n8n webhook secret
    link: `${config.publicAppUrl}/?q=${c.access_token}`
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
        previous_status: 'SAFE',
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

/**
 * POST /api/webhook/alert-manual
 * Triggered by Admin Portal to manually dispatch alerts to n8n webhook.
 * Forwards payload to: https://mystified-encrypt-reheat.ngrok-free.dev/webhook-test/alert-manual
 */
router.post('/alert-manual', async (req: Request, res: Response): Promise<void> => {
  const { severity, category, message, radiusMeters, minRiskScore } = req.body;

  const targetWebhookUrl = process.env.N8N_ALERT_WEBHOOK_URL || 'https://mystified-encrypt-reheat.ngrok-free.dev/webhook-test/alert-manual';
  
  const payload = {
    alertId: `ALT-${Math.floor(100 + Math.random() * 900)}`,
    severity: severity || 'warning',
    category: category || 'weather',
    message: message || 'Manual emergency alert transmitted',
    radiusMeters: Number(radiusMeters || 500),
    minRiskScore: Number(minRiskScore || 50),
    timestamp: new Date().toISOString(),
    source: 'Flood Guard Admin Portal'
  };

  let n8nResponse = null;
  let dispatchSuccess = false;

  try {
    const response = await fetch(targetWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-Webhook-Secret': config.n8nWebhookSecret || ''
      },
      body: JSON.stringify(payload)
    });

    dispatchSuccess = response.ok;
    try {
      n8nResponse = await response.json();
    } catch (_e) {
      n8nResponse = { statusText: response.statusText, statusCode: response.status };
    }
  } catch (err: any) {
    console.warn('[WEBHOOK] Failed to dispatch to external n8n webhook URL:', err.message);
    n8nResponse = { error: err.message || 'External webhook destination unreachable' };
  }

  await auditLog('ALERT_SENT', 'ADMIN', 'manual-broadcast', {
    targetWebhookUrl,
    dispatchSuccess,
    payload,
    n8nResponse
  });

  res.json({
    success: true,
    message: 'Manual alert broadcast processed and dispatched to n8n webhook',
    targetWebhookUrl,
    dispatchSuccess,
    payload,
    n8nResponse
  });
});

export default router;
