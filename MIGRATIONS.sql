-- MIGRATIONS.sql
-- Additive migrations for Flood Guard disaster management app
-- Run these queries in your Supabase SQL Editor.

-- 0. Ensure citizens table has all required columns (safe for existing tables)
CREATE TABLE IF NOT EXISTS citizens (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  risk_score DOUBLE PRECISION DEFAULT 0.0,
  status TEXT DEFAULT 'SAFE',
  children_count INTEGER DEFAULT 0,
  elderly_count INTEGER DEFAULT 0,
  mobility_issues BOOLEAN DEFAULT FALSE,
  access_token TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns if table already existed without them
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS elevation DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS distance_to_river DOUBLE PRECISION DEFAULT 0.0;

-- Seed initial citizens if empty
INSERT INTO citizens (name, email, phone, address, latitude, longitude, elevation, distance_to_river, risk_score, status, children_count, elderly_count, mobility_issues, access_token)
VALUES 
('Neev Ahuja', 'neev.ahuja@floodguard.gov', '+1 (555) 019-2834', '124 Riverview Road, Sector 7G', 40.7328, -74.0150, 4.2, 120.0, 78.0, 'SAFE', 1, 0, false, 'dTNScjFkXzAx'),
('Sarah Jenkins', 'sarah.j@netlink.com', '+1 (555) 019-8871', '12 Waterfront Drive, Sector 7G', 40.7302, -74.0185, 2.1, 45.0, 92.0, 'URGENT', 0, 1, true, 'dTNScjFkXzAy')
ON CONFLICT (access_token) DO NOTHING;

-- 1. Create emergency_messages table
CREATE TABLE IF NOT EXISTS emergency_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CITIZEN', 'ADMIN', 'SYSTEM')),
  message TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'TEXT' 
    CHECK (message_type IN ('TEXT', 'STATUS_UPDATE', 'EMERGENCY_REQUEST', 'SYSTEM_NOTIFICATION')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_em_citizen_id ON emergency_messages(citizen_id);
CREATE INDEX IF NOT EXISTS idx_em_created_at ON emergency_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_em_sender_type ON emergency_messages(sender_type);

-- 2. Create citizen_status_history table
CREATE TABLE IF NOT EXISTS citizen_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'CITIZEN',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_csh_citizen_id ON citizen_status_history(citizen_id);

-- 3. Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_al_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_al_created_at ON audit_logs(created_at);

-- 4. Create Radius Query function (using Haversine Formula for portability)
CREATE OR REPLACE FUNCTION get_citizens_in_radius(
  lat_val DOUBLE PRECISION,
  lng_val DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION
)
RETURNS TABLE (
  id INT,
  name TEXT,
  email TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  status TEXT,
  access_token TEXT,
  distance DOUBLE PRECISION
) 
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    c.id,
    c.name::TEXT,
    c.email::TEXT,
    c.latitude,
    c.longitude,
    c.status::TEXT,
    c.access_token::TEXT,
    (6371000 * acos(
      cos(radians(lat_val)) * cos(radians(c.latitude)) * 
      cos(radians(c.longitude) - radians(lng_val)) + 
      sin(radians(lat_val)) * sin(radians(c.latitude))
    )) AS distance
  FROM citizens c
  WHERE 
    (6371000 * acos(
      cos(radians(lat_val)) * cos(radians(c.latitude)) * 
      cos(radians(c.longitude) - radians(lng_val)) + 
      sin(radians(lat_val)) * sin(radians(c.latitude))
    )) <= radius_meters;
END;
$$ LANGUAGE plpgsql;

-- 5. Enable Row Level Security (RLS) and policies on all tables
ALTER TABLE emergency_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE citizen_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON emergency_messages;
DROP POLICY IF EXISTS "Enable write access for all users" ON emergency_messages;
DROP POLICY IF EXISTS "Enable read access for all users" ON audit_logs;
DROP POLICY IF EXISTS "Enable write access for all users" ON audit_logs;
DROP POLICY IF EXISTS "Enable read access for all users" ON citizen_status_history;
DROP POLICY IF EXISTS "Enable write access for all users" ON citizen_status_history;

CREATE POLICY "Enable read access for all users" ON emergency_messages FOR SELECT TO anon USING (true);
CREATE POLICY "Enable write access for all users" ON emergency_messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Enable read access for all users" ON audit_logs FOR SELECT TO anon USING (true);
CREATE POLICY "Enable write access for all users" ON audit_logs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Enable read access for all users" ON citizen_status_history FOR SELECT TO anon USING (true);
CREATE POLICY "Enable write access for all users" ON citizen_status_history FOR INSERT TO anon WITH CHECK (true);

