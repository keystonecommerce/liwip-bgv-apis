The table below describes the original endpoints. For the new modular integration, application-linked checks and current coverage, see [SUREPASS-BGV-INTEGRATION.md](SUREPASS-BGV-INTEGRATION.md) and [SUREPASS-COVERAGE.md](SUREPASS-COVERAGE.md). Account enablement has not been live-verified for this change.

| API name | Endpoint | Status |
|---|---|---|
| PAN Comprehensive | `POST /api/v1/pan/pan-comprehensive` | Implemented |
| Driving Licence | `POST /api/v1/driving-license/driving-license` | Implemented |
| Voter ID | `POST /api/v1/voter-id/voter-id` | Implemented |
| Address Matching | `POST /api/v1/utils/address-matching` | Implemented |
| RC V2 | `POST /api/v1/rc/rc-v2` | Implemented |
| Passport Details | `POST /api/v1/passport/passport/passport-details` | Implemented |
| CIBIL Credit Score | `POST /api/v1/credit-report-cibil/score` | Implemented |
| Face Match | `POST /api/v1/face/face-match` | Implemented |
| Face Liveness | `POST /api/v1/face/face-liveness` | Implemented |
| Employment History by UAN V2 | `POST /api/v1/income/employment-history-uan-v2` | Implemented |
| Current Employment PAN Mobile | `POST /api/v1/employment/current-employment-pan-mobile` | Implemented |
| eCourts Search V2 | `POST /api/v1/ecourts/ecourt-search-v2` | Implemented |
| eCourt Individual Court Details | `POST /api/v1/ecourts/ecourt-individual-court-details` | Implemented |
| eCourt CNR Search Advanced | `POST /api/v1/ecourts/ecourt-cnr-search-adv` | Implemented |
| Upload e-Aadhaar | `POST /api/v1/aadhaar/upload/eaadhaar` | Implemented — sandbox scope inactive |
| GST OCR | `POST /api/v1/ocr/gst` | Implemented — standalone |
| RC Full | `POST /api/v1/rc/rc-full` | Implemented — legacy only |
| DigiLocker Initialize | `POST /api/v1/digilocker/initialize` | Implemented — sandbox access pending |
| Mobile OTP Send and Resend | `POST /api/v5/flow/` | Implemented |
| Mobile OTP Verify | Internal HMAC verification with Redis expiry | Implemented |
| Aadhaar OVSE Initialize | `POST /api/v1/aadhaar-v4/initialize` | Implemented |
| Aadhaar OVSE Status | `GET /api/v1/aadhaar-v4/status` | Implemented |
| Aadhaar OVSE Result | `GET /api/v1/aadhaar-v4/result` | Implemented |
| DigiLocker Redirect URL | Returned by initialize API | Implemented |
| DigiLocker Document Retrieval — identity, education and supported skill certificates | `TBD` | Not implemented |
| Document Face Extraction | `TBD` | Not implemented |
| Document Tampering Detection | `TBD` | Not implemented |
| AI Image Detection | `TBD` | Not implemented |
| Vehicle Photo Verification | `TBD` | Not implemented |
| Vehicle Number Plate Matching | `TBD` | Not implemented |
| RC Challan | `TBD` | Not implemented |
| RC Stolen Check | `TBD` | Not implemented |
| Education Verification | `TBD` | Not implemented |
| Police Verification / PCC | `TBD` | Not implemented |
| PEP Match | `TBD` | Not implemented |
| AML / Sanctions / Watchlist Search | `TBD` | Not implemented |
