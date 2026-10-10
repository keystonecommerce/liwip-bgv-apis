# Local Surepass mock

This separate, dependency-free tool simulates provider responses for architecture testing. The production application does not import it. It binds to `127.0.0.1` and its CLI refuses `NODE_ENV=production`.

```sh
cd tools/surepass-mock
npm start
npm test
```

Configure a **local development backend** with:

```dotenv
SUREPASS_BASE_URL=http://127.0.0.1:3999
SUREPASS_BEARER_TOKEN=mock_surepass_token
```

Select a scenario without restarting either process:

```sh
curl -X POST http://127.0.0.1:3999/__mock/scenario \
  -H 'Content-Type: application/json' -d '{"scenario":"throttled_once"}'
curl http://127.0.0.1:3999/__mock/state
```

Scenarios: `success`, `negative`, `manual`, `rejected`, `malformed`, `invalid_json`, `server_error`, `timeout`, `throttled_once`. Statistics contain counts and endpoint names, never submitted identity data. `/__mock/*` controls exist only in this standalone local server.

The simulator provides the Surepass response envelope plus sample matching, liveness, court, DigiLocker and Aadhaar session fields. It intentionally does not emulate every product's payload validation or real KYC data. It proves application ownership, dispatch, billing, retries and review behavior; real vendor contracts and charge rules still require confirmation from the Surepass console. Switch the backend's existing URL and bearer configuration to use the real provider; the mock adds no production dependencies.
