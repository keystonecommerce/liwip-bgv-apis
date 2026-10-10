const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSurepassMock } = require('./server.cjs');
test('standalone mock supports authentication, failures, and retry accounting', async () => {
  const mock = createSurepassMock(), { baseUrl, token } = await mock.start();
  const send = () => fetch(`${baseUrl}/api/v1/pan/pan-comprehensive`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
  try {
    assert.equal((await fetch(`${baseUrl}/api/v1/pan/pan-comprehensive`)).status, 401);
    assert.equal(mock.state().totalCalls, 0);
    assert.equal((await (await send()).json()).success, true);
    mock.setScenario('throttled_once'); assert.equal((await send()).status, 429); assert.equal((await send()).status, 200);
    mock.setScenario('negative'); assert.equal((await (await send()).json()).data.match_status, false);
    mock.setScenario('invalid_json'); await assert.rejects((await send()).json());
    mock.setScenario('server_error'); assert.equal((await send()).status, 503);
    assert.equal(mock.state().totalCalls, 6);
  } finally { await mock.stop(); }
});
