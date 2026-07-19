import { supabaseAdmin } from '../supabase';

export type AuditEventType =
  | 'ADMIN_LOGIN_SUCCESS'
  | 'ADMIN_LOGIN_FAILURE'
  | 'ADMIN_LOGOUT'
  | 'CITIZEN_AUTH_SUCCESS'
  | 'CITIZEN_AUTH_FAILURE'
  | 'CITIZEN_MESSAGE_SENT'
  | 'ADMIN_MESSAGE_SENT'
  | 'STATUS_CHANGED'
  | 'EMERGENCY_ESCALATED'
  | 'ALERT_SENT'
  | 'ALERT_FAILED'
  | 'UNAUTHORIZED_ACCESS_ATTEMPT'
  | 'GROQ_CLASSIFICATION_FAILED'
  | 'WEBHOOK_RECEIVED'
  | 'WEBHOOK_REJECTED';

interface AuditDetails {
  citizenId?: number;
  message?: string;
  status?: string;
  category?: string;
  error?: string;
  maskedToken?: string;
  [key: string]: unknown;
}

/**
 * Audit log writer.
 * NEVER logs full access tokens, passwords, or secret keys.
 */
export async function auditLog(
  eventType: AuditEventType,
  actorType: 'ADMIN' | 'CITIZEN' | 'SYSTEM' | 'N8N',
  actorId?: string,
  details?: AuditDetails,
  ipAddress?: string
): Promise<void> {
  try {
    // Sanitize details — remove any access_token fields
    const safeDetails = details ? { ...details } : {};
    delete (safeDetails as Record<string, unknown>)['access_token'];
    delete (safeDetails as Record<string, unknown>)['token'];
    delete (safeDetails as Record<string, unknown>)['password'];

    await supabaseAdmin.from('audit_logs').insert({
      event_type: eventType,
      actor_type: actorType,
      actor_id: actorId,
      details: safeDetails,
      ip_address: ipAddress,
    });
  } catch (err) {
    // Audit failures must not crash the application
    console.error('[AUDIT] Failed to write audit log:', eventType, err);
  }
}
