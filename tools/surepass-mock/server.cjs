const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const SCENARIOS = new Set(['success', 'negative', 'manual', 'rejected', 'malformed', 'invalid_json', 'server_error', 'timeout', 'throttled_once']);

/** Dependency-free, local-only simulator. Never imported by the production app. */
function createSurepassMock({ token = 'mock_surepass_token', port = 0, timeoutMs = 3000 } = {}) {
  let scenario = 'success', scenarioCalls = 0, totalCalls = 0;
  const operations = new Map(), sessions = new Map(), sockets = new Set();
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let bytes = 0, chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { json(res, 413, { success: false, message: 'Mock payload too large' }); return; } chunks.push(chunk); }
      if (url.pathname === '/__mock/state' && req.method === 'GET') { json(res, 200, state()); return; }
      if (url.pathname === '/__mock/scenario' && req.method === 'POST') {
        const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!SCENARIOS.has(input.scenario)) { json(res, 400, { message: 'Unknown scenario', scenarios: [...SCENARIOS] }); return; }
        setScenario(input.scenario); json(res, 200, state()); return;
      }
      if (!url.pathname.startsWith('/api/v1/')) { json(res, 404, { success: false, message: 'Unknown mock route' }); return; }
      if (req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { success: false, message: 'Invalid mock bearer token' }); return; }
      totalCalls++; scenarioCalls++;
      operations.set(url.pathname, (operations.get(url.pathname) || 0) + 1);
      let body = { success: true, status_code: 200, message_code: 'success', data: { client_id: `mock_${randomUUID()}` } };
      if (scenario === 'rejected') { json(res, 422, { success: false, status_code: 422, message_code: 'invalid_input' }); return; }
      if (scenario === 'server_error') { json(res, 503, { success: false, status_code: 503, message_code: 'service_unavailable' }); return; }
      if (scenario === 'throttled_once' && scenarioCalls === 1) { json(res, 429, { success: false, status_code: 429, message_code: 'rate_limited' }); return; }
      if (scenario === 'malformed') { json(res, 200, { success: true }); return; }
      if (scenario === 'invalid_json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{invalid'); return; }
      if (scenario === 'timeout') { const timer = setTimeout(() => json(res, 200, body), timeoutMs); res.on('close', () => clearTimeout(timer)); return; }
      body.data.match_status = scenario !== 'negative'; body.data.live = scenario !== 'negative';
      // Identity lookups return a name; the backend only verifies when it matches the worker.
      body.data.full_name = body.data.name = body.data.owner_name = process.env.MOCK_NAME || 'Ravi Kumar';
      body.data.result = scenario === 'manual' ? [{ finding: 'Mock finding requiring QA' }] : [];
      if (url.pathname.endsWith('/digilocker/initialize')) {
        // The real page returns the worker to redirect_url after OTP and consent; the mock does it at once.
        let redirect = 'https://example.test/mock-session';
        try { redirect = JSON.parse(Buffer.concat(chunks).toString() || '{}').data?.redirect_url || redirect; } catch {}
        Object.assign(body.data, { token: 'mock_session_token', url: redirect, expiry_seconds: 600 });
      }
      if (url.pathname.includes('/digilocker/status/')) Object.assign(body.data, { status: 'completed', completed: true, failed: false, aadhaar_linked: true });
      if (url.pathname.includes('/digilocker/download-aadhaar/')) Object.assign(body.data, { aadhaar_xml_data: {
        full_name: process.env.MOCK_NAME || 'Ravi Kumar', dob: '15-08-1994', gender: 'M', care_of: 'S/O: Suresh Kumar', father_name: 'Suresh Kumar',
        full_address: '12 MG Road, Indiranagar, Bengaluru, Karnataka 560038', zip: '560038', masked_aadhaar: 'XXXXXXXX1234',
        profile_image: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='
      } });
      if (url.pathname.endsWith('/aadhaar-v4/initialize')) {
        // The real page sends the worker back to redirect_url after OTP; the mock does it at once.
        let redirect = 'https://example.test/mock-aadhaar';
        try { redirect = JSON.parse(Buffer.concat(chunks).toString() || '{}').redirect_url || redirect; } catch {}
        Object.assign(body.data, { url: redirect, web_link: redirect, status: 'pending', expiry_seconds: 600 }); sessions.set(body.data.client_id, true);
      }
      if (url.pathname.endsWith('/aadhaar-v4/status') || url.pathname.endsWith('/aadhaar-v4/result')) {
        const clientId = url.searchParams.get('client_id');
        if (!sessions.has(clientId)) { json(res, 404, { success: false, status_code: 404 }); return; }
        Object.assign(body.data, { client_id: clientId, status: 'completed' });
        // Identity claims an Aadhaar result carries. The photo is a 1x1 JPEG placeholder.
        if (url.pathname.endsWith('/aadhaar-v4/result')) Object.assign(body.data, {
          full_name: process.env.MOCK_NAME || 'Ravi Kumar', dob: '15-08-1994', gender: 'M', care_of: 'S/O: Suresh Kumar',
          full_address: '12 MG Road, Indiranagar, Bengaluru, Karnataka 560038', pincode: '560038', has_image: true,
          profile_image: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='
        });
      }
      json(res, 200, body);
    } catch { if (!res.headersSent) json(res, 400, { success: false, message: 'Invalid mock request' }); else res.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  function state() { return { scenario, scenarioCalls, totalCalls, operations: Object.fromEntries(operations) }; }
  function setScenario(value) { if (!SCENARIOS.has(value)) throw new Error('Unknown mock scenario'); scenario = value; scenarioCalls = 0; }
  return {
    setScenario, state,
    async start() { await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); return { baseUrl: `http://127.0.0.1:${server.address().port}`, token }; },
    async stop() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { createSurepassMock };
if (require.main === module) {
  if (process.env.NODE_ENV === 'production') { console.error('The Surepass mock is local development tooling.'); process.exit(1); }
  const mock = createSurepassMock({ port: Number(process.env.MOCK_PORT || 3999), token: process.env.MOCK_TOKEN || 'mock_surepass_token' });
  mock.start().then(({ baseUrl, token }) => console.log(`Surepass mock: ${baseUrl}\nSUREPASS_BASE_URL=${baseUrl}\nSUREPASS_BEARER_TOKEN=${token}`));
  process.on('SIGTERM', async () => { await mock.stop(); process.exit(0); });
  process.on('SIGINT', async () => { await mock.stop(); process.exit(0); });
}
