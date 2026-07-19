import bcrypt from 'bcrypt';
import { config, isUsingDefaultCredentials, isProduction } from '../config';

/**
 * Validates admin credentials server-side.
 * Supports both bcrypt hash (production) and plaintext (dev with ALLOW_DEFAULT_ADMIN=true).
 * NEVER puts password validation logic in client-side code.
 */
export async function validateAdminCredentials(username: string, password: string): Promise<boolean> {
  if (!username || !password) return false;

  // Username check
  if (username !== config.adminUsername) return false;

  // Production: must use hashed password
  if (isProduction()) {
    if (!config.adminPasswordHash) {
      console.error('[SECURITY] Production mode requires ADMIN_PASSWORD_HASH to be set.');
      return false;
    }
    return await bcrypt.compare(password, config.adminPasswordHash);
  }

  // Development: support plaintext if ALLOW_DEFAULT_ADMIN=true
  if (config.allowDefaultAdmin && config.adminPassword) {
    return password === config.adminPassword;
  }

  // Fallback to hash if provided
  if (config.adminPasswordHash) {
    return await bcrypt.compare(password, config.adminPasswordHash);
  }

  return false;
}

export function getAdminSecurityWarning(): string | null {
  if (isUsingDefaultCredentials()) {
    return 'WARNING: Application is running with default admin credentials (admin/admin). Change before production deployment.';
  }
  return null;
}
