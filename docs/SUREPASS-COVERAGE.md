# Surepass alignment coverage

Updated 2026-10-09. The supplied PDF lists **72 provider products** supporting **70 PRD checks**. Catalogue slugs are not endpoint URLs. The user-approved first phase uses public contracts and preserves existing integrations. All implementation statuses below mean code availability, **not verified account enablement or a live successful response**.

Read [integration setup and API usage](SUREPASS-BGV-INTEGRATION.md). The new BANK_REPORT operation is additional account/IFSC report coverage; it is not substituted for either penny-drop product. There are 20 new application-linked operations; DOCTOR_REGISTRATION is the public doctor lookup, with exact NMC product equivalence still pending.

| PDF # | Requested product | Code coverage | Notes |
| --- | --- | --- | --- |
| 1 | `aadhaar-v4/initialize, /status, /result` | Existing / modularized | OVSE initialize/status/result preserved; session flow. |
| 2 | `digilocker/initialize` | Existing / partial | Initialize only; issued-document lifecycle deferred. |
| 3 | `aadhaar/upload/eaadhaar` | Existing / modularized | e-Aadhaar upload preserved. |
| 4 | `aadhaar-masking-api` | New | Application-linked `AADHAAR_MASK`. |
| 5 | `pan/pan-comprehensive` | Existing / modularized | PAN comprehensive preserved. |
| 6 | `voter-id/voter-id` | Existing / modularized | Voter ID verification preserved. |
| 7 | `passport/passport/passport-details` | Existing / modularized | File number + DOB verification preserved. |
| 8 | `name-matching-api` | New | Application-linked `NAME_MATCH`. |
| 9 | `mobile-number-to-name-api` | New | Application-linked `MOBILE_NAME`. |
| 10 | `email-id-verification-api` | New | Application-linked `EMAIL_CHECK`. |
| 11 | `driving-license/driving-license` | Existing / modularized | Driving licence verification preserved. |
| 12 | `rc/rc-full, rc/rc-v2` | Existing / modularized | RC Full and V2 preserved; validity fields are evidence, not a new monitoring service. |
| 13 | `insurance-verification-api` | Deferred | RC Full may return relevant policy/PUC/permit evidence; dedicated product is deferred. |
| 14 | `pollution-check-by-vehicle-number-api` | Deferred | RC Full may return relevant policy/PUC/permit evidence; dedicated product is deferred. |
| 15 | `national-permit-verification-api` | Deferred | RC Full may return relevant policy/PUC/permit evidence; dedicated product is deferred. |
| 16 | `vehicle-challan-check` | New | Application-linked `VEHICLE_CHALLAN`. |
| 17 | `face/face-match` | Existing / modularized | Selfie/ID multipart face match preserved. |
| 18 | `face/face-liveness` | Existing / modularized | Selfie multipart liveness preserved. |
| 19 | `selfie-verification-api` | Deferred | Existing face liveness and match cover basic selfie checks; this distinct product is deferred. |
| 20 | `1n-face-search` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 21 | `impersonation-check-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 22 | `deepface-detection-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 23 | `ai-image-detector-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 24 | `detect-fake-documents` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 25 | `document-forgery-detection-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 26 | `pan-tampering-detection-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 27 | `aadhaar-card-ocr-api` | New | Application-linked `AADHAAR_OCR`. |
| 28 | `pan-ocr-api` | New | Application-linked `PAN_OCR`. |
| 29 | `driving-license-ocr-api` | New | Application-linked `LICENSE_OCR`. |
| 30 | `vehicle-rc-ocr-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 31 | `voter-id-ocr` | New | Application-linked `VOTER_OCR`. |
| 32 | `passport-ocr-api` | New | Application-linked `PASSPORT_OCR`. International-passport OCR. |
| 33 | `document-extraction-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 34 | `utils/address-matching` | Existing / modularized | Address match preserved. |
| 35 | `address-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 36 | `address-proof-documents-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 37 | `electricity-bill-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 38 | `digipin-check-api` | New | Application-linked `DIGIPIN`. Coordinate encoding; does not verify occupancy. |
| 39 | `digipin-reverse-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 40 | `ecourts/ecourt-search-v2` | Existing / modularized | Search V2 preserved; matches require review. |
| 41 | `ecourts/ecourt-individual-court-details` | Existing / partial | Existing standalone details operation preserved; initialization/client-ID lifecycle is not added. |
| 42 | `ecourts/ecourt-cnr-search-adv` | Existing / partial | Existing standalone advanced CNR operation preserved; console contract reconfirmation needed. |
| 43 | `court-record-verification-api` | Deferred | Court search exists; this distinct product is deferred. No police/PCC coverage. |
| 44 | `anti-money-laundering-aml-api` | New | Application-linked `AML`. |
| 45 | `pep-match-api` | New | Application-linked `PEP`. |
| 46 | `penny-drop-api` | Deferred | BANK_REPORT offers documented account/IFSC report retrieval; exact penny-drop/pennyless contract deferred. |
| 47 | `penny-less-bank-account-verification` | Deferred | BANK_REPORT offers documented account/IFSC report retrieval; exact penny-drop/pennyless contract deferred. |
| 48 | `ifsc-code-verification-api` | New | Application-linked `IFSC`. |
| 49 | `upi-id-verification-api` | New | Application-linked `UPI`. |
| 50 | `income/employment-history-uan-v2` | Existing / modularized | UAN employment history preserved. |
| 51 | `employment/current-employment-pan-mobile` | Existing / modularized | Current employment preserved. |
| 52 | `employment-verification-api` | Deferred | Existing UAN history/current-employment operations provide evidence; this distinct product contract is deferred. |
| 53 | `uan-verification-api` | Deferred | Existing UAN history/current-employment operations provide evidence; this distinct product contract is deferred. |
| 54 | `epfo-passbook-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 55 | `salary-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 56 | `form-26as-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 57 | `10th-marksheet-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 58 | `12th-marksheet-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 59 | `nmc-verification-api` | New / partial | Application-linked `DOCTOR_REGISTRATION`. Public doctor lookup; exact NMC-specific equivalence must be confirmed. |
| 60 | `nurse-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 61 | `icai-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 62 | `icsi-verification-api` | New | Application-linked `ICSI`. |
| 63 | `insurance-agent-verification-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 64 | `credit-report-cibil/score` | Existing / modularized | CIBIL score preserved; now requires review. |
| 65 | `experian-credit-report-api` | New | Application-linked `EXPERIAN_REPORT`. |
| 66 | `equifax-credit-report-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 67 | `crif-credit-report-api` | New | Application-linked `CRIF_REPORT`. |
| 68 | `loan-defaulter-check-api` | Deferred | Awaiting an exact endpoint/payload/response or multi-step lifecycle contract from the console. |
| 69 | `insurance-monitoring-api` | Deferred | Monitoring subscriptions, webhooks and scheduler contracts are deferred; existing checks can be explicitly rerun. |
| 70 | `vehicle-monitoring-api` | Deferred | Monitoring subscriptions, webhooks and scheduler contracts are deferred; existing checks can be explicitly rerun. |
| 71 | `challan-monitoring-api` | Deferred | Monitoring subscriptions, webhooks and scheduler contracts are deferred; existing checks can be explicitly rerun. |
| 72 | `employment-monitoring-api` | Deferred | Monitoring subscriptions, webhooks and scheduler contracts are deferred; existing checks can be explicitly rerun. |

The 48 PRD checks the PDF says Surepass does not support remain outside this integration. These include physical address visits, police/PCC, gig platform work history, university degrees and device fingerprinting. Do not advertise automated coverage for these based on the APIs above.

Each new adapter links its public source under `integrations/surepass/checks/`. Some references were available through indexed public API pages while the portal itself requested a password. Confirm sandbox payloads and product permissions before production rollout. No placeholder endpoints or guessed catalogue-slug routes were added.
