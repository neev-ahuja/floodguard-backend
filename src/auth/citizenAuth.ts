import { supabaseAdmin } from '../supabase';
import { auditLog } from '../services/audit';

// Safe hash of token for logging — never log the full token
function maskToken(token: string): string {
  if (!token || token.length < 8) return '***';
  return token.substring(0, 4) + '...' + token.substring(token.length - 4);
}

export interface CitizenSession {
  citizenId: number;
  name: string;
}

/**
 * Validates a citizen access_token against the Supabase citizens table.
 * Returns the citizen's id and name — never the access_token itself.
 */
export async function validateCitizenToken(token: string): Promise<CitizenSession | null> {
  if (!token || typeof token !== 'string' || token.length < 8) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('citizens')
    .select('id, name, status')
    .eq('access_token', token)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    citizenId: data.id,
    name: data.name,
  };
}

/**
 * Returns safe public citizen data for the authenticated citizen.
 * NEVER returns access_token.
 */
export async function getCitizenPublicProfile(citizenId: number) {
  const { data, error } = await supabaseAdmin
    .from('citizens')
    .select('id, name, status, risk_score, latitude, longitude, children_count, elderly_count, mobility_issues')
    .eq('id', citizenId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Generates a personalized emergency link for a citizen.
 * Retrieves existing access_token — does NOT create a new one.
 */
export async function generateCitizenEmergencyLink(
  citizenId: number,
  publicAppUrl: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('citizens')
    .select('access_token')
    .eq('id', citizenId)
    .maybeSingle();

  if (error || !data?.access_token) return null;

  // Token is used only for URL generation — never returned to API responses
  return `${publicAppUrl}/respond?token=${data.access_token}`;
}
