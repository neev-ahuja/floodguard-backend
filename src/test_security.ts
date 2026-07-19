import http from 'http';
import { supabaseAdmin } from './supabase';

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

// Helper to perform HTTP Requests and track cookies
function makeRequest(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  data?: any,
  cookieHeader?: string
): Promise<{ status: number; body: any; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };

    if (data) {
      headers['Content-Length'] = String(Buffer.byteLength(postData));
    }

    const options: http.RequestOptions = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: headers,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed = body;
        try {
          parsed = JSON.parse(body);
        } catch {}
        
        const setCookieHeaders = res.headers['set-cookie'] || [];
        resolve({
          status: res.statusCode || 500,
          body: parsed,
          cookies: setCookieHeaders,
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (data) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('==================================================');
  console.log('     FLOOD GUARD SECURITY INTEGRATION TESTS');
  console.log('==================================================\n');

  // Step 1: Query a real citizen token from database
  console.log('[Setup] Querying database for a valid citizen...');
  const { data: dbCitizens, error: dbErr } = await supabaseAdmin
    .from('citizens')
    .select('id, access_token, name')
    .limit(1);

  if (dbErr || !dbCitizens || dbCitizens.length === 0) {
    console.error('❌ Failed to retrieve seed citizen from database:', dbErr);
    process.exit(1);
  }

  const testCitizen = dbCitizens[0];
  console.log(`[Setup] Using citizen: ${testCitizen.name} (Token: ${testCitizen.access_token})\n`);

  let citizenCookie = '';
  let adminCookie = '';

  try {
    // ----------------------------------------------------
    // TEST 1: Citizen Auth Flow
    // ----------------------------------------------------
    console.log('TEST 1: Citizen Authentication');
    const authRes = await makeRequest('POST', '/api/auth/citizen/validate', {
      token: testCitizen.access_token,
    });

    if (authRes.status === 200 && authRes.body.success) {
      console.log('  ✅ Success: Citizen authenticated successfully.');
      citizenCookie = authRes.cookies[0]?.split(';')[0] || '';
    } else {
      console.error('  ❌ Failure: Citizen authentication failed.', authRes.status, authRes.body);
    }

    // Verify session
    if (citizenCookie) {
      const sessionRes = await makeRequest('GET', '/api/auth/session', null, citizenCookie);
      if (sessionRes.status === 200 && sessionRes.body.role === 'citizen') {
        console.log('  ✅ Success: Citizen session role verified.');
      } else {
        console.error('  ❌ Failure: Citizen session role incorrect.', sessionRes.status, sessionRes.body);
      }
    }

    // Invalid Token Check
    const badAuthRes = await makeRequest('POST', '/api/auth/citizen/validate', {
      token: 'invalid-access-token-12345',
    });
    if (badAuthRes.status === 401) {
      console.log('  ✅ Success: Invalid citizen token correctly blocked (401).');
    } else {
      console.error('  ❌ Failure: Invalid citizen token allowed.', badAuthRes.status);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 2: Citizen Data Isolation & Scoping
    // ----------------------------------------------------
    console.log('TEST 2: Citizen Data Isolation');
    if (!citizenCookie) {
      throw new Error('Skipping Test 2: no citizen cookie available');
    }

    // Get own profile
    const profileRes = await makeRequest('GET', '/api/citizen/profile', null, citizenCookie);
    if (profileRes.status === 200 && profileRes.body.citizen.id === testCitizen.id) {
      console.log(`  ✅ Success: Retrieved own profile correctly (ID: ${profileRes.body.citizen.id}).`);
    } else {
      console.error('  ❌ Failure: Could not retrieve own profile.', profileRes.status, profileRes.body);
    }

    // Attempt unauthorized actions
    const unauthorizedAdminCall = await makeRequest('GET', '/api/admin/citizens', null, citizenCookie);
    if (unauthorizedAdminCall.status === 403 || unauthorizedAdminCall.status === 401) {
      console.log(`  ✅ Success: Citizen blocked from calling admin endpoints (${unauthorizedAdminCall.status}).`);
    } else {
      console.error('  ❌ Failure: Citizen bypassed security check to fetch admin citizens.', unauthorizedAdminCall.status);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 3: Admin Auth Flow
    // ----------------------------------------------------
    console.log('TEST 3: Admin Authentication');
    const adminAuthRes = await makeRequest('POST', '/api/auth/admin/login', {
      username: 'admin',
      password: 'admin',
    });

    if (adminAuthRes.status === 200 && adminAuthRes.body.success) {
      console.log('  ✅ Success: Admin authenticated successfully.');
      adminCookie = adminAuthRes.cookies[0]?.split(';')[0] || '';
    } else {
      console.error('  ❌ Failure: Admin authentication failed.', adminAuthRes.status, adminAuthRes.body);
    }

    // Verify session
    if (adminCookie) {
      const sessionRes = await makeRequest('GET', '/api/auth/session', null, adminCookie);
      if (sessionRes.status === 200 && sessionRes.body.role === 'admin') {
        console.log('  ✅ Success: Admin session role verified.');
      } else {
        console.error('  ❌ Failure: Admin session role incorrect.', sessionRes.status, sessionRes.body);
      }
    }

    // Bad Admin Credentials Check
    const badAdminAuthRes = await makeRequest('POST', '/api/auth/admin/login', {
      username: 'admin',
      password: 'wrongpassword',
    });
    if (badAdminAuthRes.status === 401) {
      console.log('  ✅ Success: Wrong admin password correctly blocked (401).');
    } else {
      console.error('  ❌ Failure: Wrong admin password allowed.', badAdminAuthRes.status);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 4: Admin Access & Dispatch Operations
    // ----------------------------------------------------
    console.log('TEST 4: Admin Authorized Operations');
    if (!adminCookie) {
      throw new Error('Skipping Test 4: no admin cookie available');
    }

    const adminCitizensRes = await makeRequest('GET', '/api/admin/citizens', null, adminCookie);
    if (adminCitizensRes.status === 200 && Array.isArray(adminCitizensRes.body.citizens)) {
      console.log(`  ✅ Success: Admin fetched citizen matrix (Found ${adminCitizensRes.body.citizens.length} citizens).`);
    } else {
      console.error('  ❌ Failure: Admin blocked from reading citizen matrix.', adminCitizensRes.status);
    }

    // Admin updates citizen status via PATCH /api/admin/citizens/:id/status
    const updateRes = await makeRequest('PATCH', `/api/admin/citizens/${testCitizen.id}/status`, {
      status: 'URGENT',
    }, adminCookie);

    if (updateRes.status === 200) {
      console.log('  ✅ Success: Admin updated citizen safety status to URGENT.');
    } else {
      console.error('  ❌ Failure: Admin status update rejected.', updateRes.status, updateRes.body);
    }
    console.log('');

    // ----------------------------------------------------
    // TEST 5: Security Audit Log Persistence
    // ----------------------------------------------------
    console.log('TEST 5: Audit Log Integrity');
    // Query database directly to check if audit logs were created
    const { data: logs, error: logsErr } = await supabaseAdmin
      .from('audit_logs')
      .select('id, event_type, actor_type, actor_id, details, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    if (logsErr || !logs) {
      if (logsErr && logsErr.message && logsErr.message.includes('public.audit_logs')) {
        console.warn('  ⚠️ Warning: audit_logs table not found in your Supabase schema yet. Run MIGRATIONS.sql to enable audit log persistence.');
      } else {
        console.error('  ❌ Failure: Could not query audit_logs from database.', logsErr);
      }
    } else {
      console.log('  Recent Audit Logs persisted in database:');
      logs.forEach((log) => {
        console.log(`    - [${log.event_type}] Role: ${log.actor_type} | Actor ID: ${log.actor_id} (${log.created_at})`);
      });
      
      const hasLoginLog = logs.some(l => l.event_type === 'CITIZEN_AUTH_SUCCESS' || l.event_type === 'ADMIN_LOGIN_SUCCESS');
      const hasStatusLog = logs.some(l => l.event_type === 'STATUS_CHANGED');

      if (hasLoginLog && hasStatusLog) {
        console.log('  ✅ Success: End-to-end audit logging verified.');
      } else {
        console.warn('  ⚠️ Warning: Expected login and status logs not found in recent logs.');
      }
    }
    console.log('');

  } catch (err) {
    console.error('❌ Error executing security tests:', err);
  }

  console.log('==================================================');
  console.log('     SECURITY INTEGRATION TESTS COMPLETED');
  console.log('==================================================');
}

runTests();
