import dotenv from 'dotenv';
dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional_env(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optional_env('PORT', '3001')),
  nodeEnv: optional_env('NODE_ENV', 'development'),
  sessionSecret: optional_env('SESSION_SECRET', 'dev-secret-change-in-production-immediately'),
  supabaseUrl: require_env('SUPABASE_URL'),
  supabaseAnonKey: require_env('SUPABASE_ANON_KEY'),
  supabaseSecretKey: require_env('SUPABASE_SECRET_KEY'),
  adminUsername: optional_env('ADMIN_USERNAME', 'admin'),
  adminPassword: optional_env('ADMIN_PASSWORD', ''),
  adminPasswordHash: optional_env('ADMIN_PASSWORD_HASH', ''),
  allowDefaultAdmin: optional_env('ALLOW_DEFAULT_ADMIN', 'true') === 'true',
  groqApiKey: optional_env('GROQ_API_KEY', ''),
  brevoApiKey: optional_env('BREVO_API_KEY', ''),
  n8nWebhookUrl: optional_env('N8N_WEBHOOK_URL', ''),
  n8nWebhookSecret: optional_env('N8N_WEBHOOK_SECRET', ''),
  publicAppUrl: optional_env('PUBLIC_APP_URL', 'http://localhost:5173'),
  frontendUrl: optional_env('FRONTEND_URL', 'http://localhost:5173'),
};

export function isUsingDefaultCredentials(): boolean {
  return config.adminUsername === 'admin' && config.adminPassword === 'admin' && !config.adminPasswordHash;
}

export function isProduction(): boolean {
  return config.nodeEnv === 'production';
}
