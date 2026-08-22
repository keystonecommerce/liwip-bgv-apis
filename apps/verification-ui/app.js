const API_BASE_URL = "http://localhost:3000";
const form = document.querySelector("#application-form");
const submitButton = document.querySelector("#submit-button");
const formMessage = document.querySelector("#form-message");
const emptyState = document.querySelector("#empty-state");
const resultState = document.querySelector("#result-state");
const applicationStatus = document.querySelector("#application-status");
const applicationId = document.querySelector("#application-id");
const verificationProgressText = document.querySelector("#verification-progress-text");
const verificationProgressBar = document.querySelector("#verification-progress-bar");
const queuedCount = document.querySelector("#queued-count");
const processingCount = document.querySelector("#processing-count");
const verifiedCount = document.querySelector("#verified-count");
const failedCount = document.querySelector("#failed-count");
const reviewCount = document.querySelector("#review-count");
const verificationList = document.querySelector("#verification-list");
const lastUpdated = document.querySelector("#last-updated");
const refreshButton = document.querySelector("#refresh-button");
const gstForm = document.querySelector("#gst-form");
const gstButton = document.querySelector("#gst-button");
const gstMessage = document.querySelector("#gst-message");
const gstResult = document.querySelector("#gst-result");
const panForm = document.querySelector("#pan-form");
const panButton = document.querySelector("#pan-button");
const panMessage = document.querySelector("#pan-message");
const panResult = document.querySelector("#pan-result");
const licenseForm = document.querySelector("#license-form");
const licenseButton = document.querySelector("#license-button");
const licenseMessage = document.querySelector("#license-message");
const licenseResult = document.querySelector("#license-result");
const licenseResultDetails = document.querySelector("#license-result-details");
const panResultDetails = document.querySelector("#pan-result-details");
const voterForm = document.querySelector("#voter-form");
const voterButton = document.querySelector("#voter-button");
const voterMessage = document.querySelector("#voter-message");
const voterResult = document.querySelector("#voter-result");
const voterResultDetails = document.querySelector("#voter-result-details");
const rcForm = document.querySelector("#rc-form");
const rcButton = document.querySelector("#rc-button");
const rcMessage = document.querySelector("#rc-message");
const rcResult = document.querySelector("#rc-result");
const rcResultDetails = document.querySelector("#rc-result-details");
const addressForm = document.querySelector("#address-form");
const addressButton = document.querySelector("#address-button");
const addressMessage = document.querySelector("#address-message");
const addressResult = document.querySelector("#address-result");
const cibilForm = document.querySelector("#cibil-form");
const cibilButton = document.querySelector("#cibil-button");
const cibilMessage = document.querySelector("#cibil-message");
const cibilResult = document.querySelector("#cibil-result");
const passportForm = document.querySelector("#passport-form");
const passportButton = document.querySelector("#passport-button");
const passportMessage = document.querySelector("#passport-message");
const passportResult = document.querySelector("#passport-result");
const passportResultDetails = document.querySelector("#passport-result-details");
const eaadhaarForm = document.querySelector("#eaadhaar-form");
const eaadhaarButton = document.querySelector("#eaadhaar-button");
const eaadhaarMessage = document.querySelector("#eaadhaar-message");
const eaadhaarResult = document.querySelector("#eaadhaar-result");

let currentApplicationId = null;
let pollTimer = null;

const prettyType = (type) => type.replaceAll("_", " ");
const statusClass = (status) => {
  if (["VERIFIED"].includes(status)) return "success";
  if (["FAILED"].includes(status)) return "failed";
  if (["MANUAL_REVIEW"].includes(status)) return "review";
  if (["PROCESSING", "QUEUED", "PENDING", "PENDING_VERIFICATION", "VERIFICATION_IN_PROGRESS"].includes(status)) return "working";
  return "neutral";
};
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const fieldLabel = (key) => key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
function displayValue(key, value) {
  if (["profile_image", "face"].includes(key)) return value ? "Available (hidden)" : "Not available";
  if (value === null || value === undefined || value === "") return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    return value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
      ? value.map((item) => displayValue(key, item)).join(", ")
      : `${value.length} record${value.length === 1 ? "" : "s"}`;
  }
  const text = String(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
function renderProviderFields(value) {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value).map(([key, child]) => {
    if (Array.isArray(child) && child.some((item) => item && typeof item === "object")) {
      return `<section class="provider-subsection"><h4>${escapeHtml(fieldLabel(key))}</h4><div class="provider-record-list">${child.map((item, index) => {
        if (!item || typeof item !== "object") return `<div class="provider-field"><span>${escapeHtml(fieldLabel(key))}</span><strong>${escapeHtml(displayValue(key, item))}</strong></div>`;
        return `<article class="provider-record"><h5>${escapeHtml(fieldLabel(key))} ${index + 1}</h5><div class="provider-fields">${renderProviderFields(item)}</div></article>`;
      }).join("")}</div></section>`;
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      return `<section class="provider-subsection"><h4>${escapeHtml(fieldLabel(key))}</h4><div class="provider-fields">${renderProviderFields(child)}</div></section>`;
    }
    return `<div class="provider-field"><span>${escapeHtml(fieldLabel(key))}</span><strong>${escapeHtml(displayValue(key, child))}</strong></div>`;
  }).join("");
}
function renderProviderBody(value) {
  if (!value) return "";
  const data = value.data && typeof value.data === "object" ? value.data : value;
  const isEnvelope = Object.prototype.hasOwnProperty.call(value, "success") || Object.prototype.hasOwnProperty.call(value, "status_code");
  const success = value.success === true || (!isEnvelope && data === value);
  const statusText = success ? "Verified" : value.status_code === 422 ? "Could not verify" : "Request not completed";
  const caseResults = Array.isArray(data?.result) ? data.result : null;
  const caseSection = caseResults ? `<section class="provider-section"><h4>${caseResults.length ? `${caseResults.length} possible case(s) found` : "No matching cases found"}</h4>${caseResults.slice(0, 5).map((item) => `<div class="provider-case"><strong>${escapeHtml(item.case_name || item.case_no || "Court case")}</strong><span>${escapeHtml(item.case_status || "Status not available")} · ${escapeHtml(item.court_name || item.court_type || "Court not available")}</span><span>${escapeHtml(item.case_type || item.case_type_name || "Case type not available")}</span></div>`).join("")}</section>` : "";
  const displayData = caseResults ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "result")) : data;
  return `<div class="provider-result"><div class="provider-summary"><div><span>Result</span><strong class="${success ? "provider-ok" : "provider-failed"}">${statusText}</strong></div><div><span>Provider status</span><strong>${escapeHtml(value.status_code ?? "Not available")}</strong></div>${value.message ? `<div><span>Message</span><strong>${escapeHtml(value.message)}</strong></div>` : ""}</div>${data ? `${renderVehicleCompliance(data)}<section class="provider-section"><h4>Returned information</h4><div class="provider-fields">${renderProviderFields(displayData)}</div></section>${caseSection}` : ""}</div>`;
}
function renderAddressMatchBody(value) {
  if (!value) return "";
  const data = value.data && typeof value.data === "object" ? value.data : null;
  const matched = data?.match_status === true;
  const score = data?.match_score;
  return `<div class="provider-result"><div class="provider-summary"><div><span>Address result</span><strong class="${matched ? "provider-ok" : "provider-failed"}">${matched ? "Addresses match" : "Addresses do not match"}</strong></div><div><span>Similarity score</span><strong>${escapeHtml(score ?? "Not available")}</strong></div><div><span>Provider status</span><strong>${escapeHtml(value.status_code ?? "Not available")}</strong></div></div>${data ? `<section class="provider-section"><h4>Compared addresses</h4><div class="provider-fields">${renderProviderFields({address_1: data.address_1, address_2: data.address_2})}</div></section>` : value.message ? `<section class="provider-section"><h4>Message</h4><div class="provider-fields">${renderProviderFields({message: value.message})}</div></section>` : ""}</div>`;
}
function renderVehicleCompliance(data) {
  if (!data || typeof data !== "object" || !("insurance_upto" in data || "pucc_upto" in data || "fit_up_to" in data || "permit_valid_upto" in data)) return "";
  const check = (date, notApplicable = false) => {
    if (!date) return { label: notApplicable ? "Not applicable" : "Not available", className: notApplicable ? "provider-ok" : "provider-failed" };
    const valid = new Date(String(date)).getTime() >= Date.now();
    return { label: valid ? `Valid until ${date}` : `Expired on ${date}`, className: valid ? "provider-ok" : "provider-failed" };
  };
  const items = [
    ["Insurance", check(data.insurance_upto)],
    ["PUC / emission", check(data.pucc_upto)],
    ["Fitness", check(data.fit_up_to)],
    ["Permit", check(data.permit_valid_upto, true)],
    ["RC status", { label: data.rc_status || "Not available", className: String(data.rc_status || "").toUpperCase() === "ACTIVE" ? "provider-ok" : "provider-failed" }],
    ["Blacklist", { label: data.blacklist_status || "Not available", className: !data.blacklist_status || String(data.blacklist_status).toLowerCase() === "clear" ? "provider-ok" : "provider-failed" }]
  ];
  return `<section class="provider-section"><h4>Vehicle compliance checkpoints</h4><div class="provider-summary">${items.map(([label, result]) => `<div><span>${escapeHtml(label)}</span><strong class="${result.className}">${escapeHtml(result.label)}</strong></div>`).join("")}</div></section>`;
}
function renderCibilBody(value) {
  if (!value) return "";
  const data = value.data && typeof value.data === "object" ? value.data : null;
  const score = Number(data?.credit_score);
  const scoreLabel = Number.isFinite(score)
    ? score >= 750 ? "Excellent" : score >= 700 ? "Good" : score >= 650 ? "Fair" : "Needs review"
    : "Not available";
  return `<div class="provider-result"><div class="provider-summary"><div><span>Credit score</span><strong class="${Number.isFinite(score) && score >= 700 ? "provider-ok" : "provider-failed"}">${escapeHtml(data?.credit_score ?? "Not available")}</strong></div><div><span>Score range</span><strong>300–900</strong></div><div><span>Assessment</span><strong>${scoreLabel}</strong></div></div>${data ? `<section class="provider-section"><h4>Returned information</h4><div class="provider-fields">${renderProviderFields({name: data.name, pan: data.pan, mobile: data.mobile, gender: data.gender, client_id: data.client_id})}</div></section>` : value.message ? `<section class="provider-section"><h4>Message</h4><div class="provider-fields">${renderProviderFields({message: value.message})}</div></section>` : ""}</div>`;
}
const responsePreview = (value) => value ? `<details class="provider-response"><summary>View result details</summary>${renderProviderBody(value)}</details>` : "";
function friendlyVerificationMessage(verification) {
  const response = verification.failureResponse || verification.result || {};
  const providerStatus = response.status_code;
  if (verification.status === "VERIFIED") return { title: "Verification successful", text: "The provider verified these details successfully." };
  if (verification.status === "MANUAL_REVIEW") return { title: "Manual review required", text: "The provider needs a person to review these details." };
  if (verification.status === "PENDING") return { title: "Verification is still pending", text: "The provider has not finished checking these details yet." };
  if (verification.type === "FACE_LIVENESS" && verification.status === "FAILED") return { title: "Liveness check failed", text: "The selfie could not be confirmed as a live person. Ask the worker to retake it in good lighting without filters." };
  if (verification.type === "FACE_MATCH" && verification.status === "FAILED") return { title: "Face match failed", text: "The selfie and identity-document photo did not match with enough confidence. Send the worker for manual review or retake both images." };
  if (verification.type === "ECOURTS_SEARCH" && verification.status === "MANUAL_REVIEW") return { title: "Court records need review", text: "A possible court record was returned. This is not an automatic rejection; an authorised reviewer must inspect the result." };
  if (verification.type === "ECOURTS_SEARCH" && verification.status === "VERIFIED") return { title: "No matching court records found", text: "The eCourts search returned no matching records for the supplied name, father name and address." };
  if (verification.type === "ADDRESS_MATCHING" && verification.status === "FAILED") return { title: "Addresses do not match", text: "The submitted address and the address returned from Aadhaar are different. Review the address or send this case for manual review." };
  if (verification.status === "FAILED" && providerStatus === 401) return { title: "Authentication problem", text: "The Sandbox token or Customer ID is not accepted. Ask the project administrator to check the provider credentials." };
  if (verification.status === "FAILED" && providerStatus === 422) return { title: "Details could not be verified", text: "Surepass received the request, but could not find a matching official record. Check that the licence number and date of birth belong together, or use the official Sandbox test data." };
  if (verification.status === "FAILED" && providerStatus === 400) return { title: "Some request details need correction", text: "Check the licence number, date of birth, and required fields, then try again." };
  if (verification.status === "FAILED") return { title: "Verification failed", text: "The provider could not complete this check. Please try again or contact the administrator." };
  return { title: "Verification in progress", text: "The background worker is processing this check." };
}

function renderApplication(application) {
  emptyState.hidden = true;
  resultState.hidden = false;
  applicationId.textContent = application.id;
  applicationStatus.textContent = application.status.replaceAll("_", " ");
  applicationStatus.className = `status-chip ${statusClass(application.status)}`;
  const counts = application.verifications.reduce((summary, verification) => {
    const status = verification.status;
    if (status === "QUEUED" || status === "PENDING") summary.queued += 1;
    else if (status === "PROCESSING") summary.processing += 1;
    else if (status === "VERIFIED") summary.verified += 1;
    else if (status === "FAILED") summary.failed += 1;
    else if (status === "MANUAL_REVIEW") summary.review += 1;
    return summary;
  }, { queued: 0, processing: 0, verified: 0, failed: 0, review: 0 });
  const total = application.verifications.length;
  const completed = counts.verified + counts.failed + counts.review;
  queuedCount.textContent = counts.queued;
  processingCount.textContent = counts.processing;
  verifiedCount.textContent = counts.verified;
  failedCount.textContent = counts.failed;
  reviewCount.textContent = counts.review;
  verificationProgressText.textContent = `${completed} / ${total} completed`;
  verificationProgressBar.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  verificationList.innerHTML = application.verifications.map((verification) => `
    <article class="verification-card">
      <div class="verification-type">${prettyType(verification.type)}</div>
      <div class="verification-state ${verification.status.toLowerCase()}">${verification.status.replaceAll("_", " ")}</div>
      <div class="verification-meta">Attempt ${verification.attemptCount} · ${verification.provider}</div>
      ${(() => { const message = friendlyVerificationMessage(verification); return `<div class="user-message"><strong>${message.title}</strong><span>${message.text}</span></div>`; })()}
      ${!verification.failureResponse && verification.failureReason ? `<div class="technical-error">${escapeHtml(verification.failureReason)}</div>` : ""}
      ${responsePreview(verification.result || verification.failureResponse)}
    </article>
  `).join("");
  lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function loadApplication() {
  if (!currentApplicationId) return;
  const response = await fetch(`${API_BASE_URL}/applications/${currentApplicationId}/verifications`);
  if (!response.ok) throw new Error(`Could not load application (${response.status})`);
  const application = await response.json();
  renderApplication(application);
  const active = application.verifications.some((item) => ["QUEUED", "PROCESSING"].includes(item.status));
  if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastUpdated.textContent = `Completed at ${new Date().toLocaleTimeString()}`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  formMessage.className = "form-message";
  formMessage.textContent = "Uploading worker details and queuing verification jobs…";
  if (pollTimer) clearInterval(pollTimer);

  const formData = new FormData(form);

  try {
    const response = await fetch(`${API_BASE_URL}/worker-verifications`, {
      method: "POST",
      body: formData
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "Worker verification could not be created");
    currentApplicationId = body.id;
    formMessage.textContent = "Jobs created. Watching the worker checks…";
    renderApplication(body);
    pollTimer = setInterval(() => loadApplication().catch((error) => { formMessage.className = "form-message error"; formMessage.textContent = error.message; }), 1000);
    await loadApplication();
  } catch (error) {
    formMessage.className = "form-message error";
    formMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => loadApplication().catch((error) => {
  formMessage.className = "form-message error";
  formMessage.textContent = error.message;
}));

gstForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#gst-file").files?.[0];
  if (!file) return;
  gstButton.disabled = true;
  gstMessage.className = "form-message";
  gstMessage.textContent = "Uploading the certificate to NestJS and calling Surepass…";
  gstResult.hidden = true;
  const formData = new FormData();
  formData.append("file", file);
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/gst`, { method: "POST", body: formData });
    const body = await response.json();
    gstResult.textContent = JSON.stringify(body, null, 2);
    gstResult.hidden = false;
    gstMessage.textContent = response.ok && body.statusCode === 200 ? "Surepass returned a response." : `Surepass returned HTTP ${body.statusCode || response.status}.`;
  } catch (error) {
    gstMessage.className = "form-message error";
    gstMessage.textContent = error.message;
  } finally {
    gstButton.disabled = false;
  }
});

eaadhaarForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = document.querySelector("#eaadhaar-file").files?.[0];
  const fullName = document.querySelector("#eaadhaar-full-name").value.trim();
  const yob = document.querySelector("#eaadhaar-yob").value.trim();
  if (!file || !fullName || !/^\d{4}$/.test(yob)) return;

  eaadhaarButton.disabled = true;
  eaadhaarMessage.className = "form-message";
  eaadhaarMessage.textContent = "Uploading the e-Aadhaar PDF and calling Surepass…";
  eaadhaarResult.hidden = true;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("full_name", fullName);
  formData.append("yob", yob);

  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/aadhaar/eaadhaar`, { method: "POST", body: formData });
    const body = await response.json();
    eaadhaarResult.innerHTML = renderProviderBody(body);
    eaadhaarResult.hidden = false;
    eaadhaarMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    eaadhaarMessage.textContent = response.ok && body.success === true
      ? "e-Aadhaar verified successfully."
      : body.status_code === 422
        ? "The file was received, but Surepass could not verify it. Check that it is the original e-Aadhaar PDF."
        : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    eaadhaarMessage.className = "form-message error";
    eaadhaarMessage.textContent = error.message;
  } finally {
    eaadhaarButton.disabled = false;
  }
});

panForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  panButton.disabled = true;
  panMessage.className = "form-message";
  panMessage.textContent = "Sending PAN details to Surepass…";
  panResultDetails.hidden = true;
  const values = Object.fromEntries(new FormData(panForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/pan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    panResult.innerHTML = renderProviderBody(body);
    panResultDetails.hidden = false;
    panMessage.textContent = response.ok && body.success === true ? "PAN verification succeeded." : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    panMessage.className = "form-message error";
    panMessage.textContent = error.message;
  } finally {
    panButton.disabled = false;
  }
});

voterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  voterButton.disabled = true;
  voterMessage.className = "form-message";
  voterMessage.textContent = "Sending voter details to Surepass…";
  voterResultDetails.hidden = true;
  const values = Object.fromEntries(new FormData(voterForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/voter-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    voterResult.innerHTML = renderProviderBody(body);
    voterResultDetails.hidden = false;
    voterMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    voterMessage.textContent = response.ok && body.success === true
      ? "Voter ID verified successfully."
      : body.status_code === 400
        ? "The Voter ID format or number was not accepted. Check the EPIC number and the matching personal details."
        : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    voterMessage.className = "form-message error";
    voterMessage.textContent = error.message;
  } finally {
    voterButton.disabled = false;
  }
});

rcForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rcButton.disabled = true;
  rcMessage.className = "form-message";
  rcMessage.textContent = "Sending vehicle details to Surepass…";
  rcResultDetails.hidden = true;
  const values = Object.fromEntries(new FormData(rcForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/rc-full`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    rcResult.innerHTML = renderProviderBody(body);
    rcResultDetails.hidden = false;
    rcMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    rcMessage.textContent = response.ok && body.success === true
      ? "Vehicle RC verified successfully."
      : body.status_code === 422
        ? "The vehicle number was received, but Surepass could not verify it. Use valid Sandbox test data."
        : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    rcMessage.className = "form-message error";
    rcMessage.textContent = error.message;
  } finally {
    rcButton.disabled = false;
  }
});

addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addressButton.disabled = true;
  addressMessage.className = "form-message";
  addressMessage.textContent = "Comparing both addresses with Surepass…";
  addressResult.hidden = true;
  const values = Object.fromEntries(new FormData(addressForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/address-matching`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    addressResult.innerHTML = renderAddressMatchBody(body);
    addressResult.hidden = false;
    const matched = body.data?.match_status === true;
    addressMessage.className = response.ok && body.success === true && matched ? "form-message success-message" : "form-message error";
    addressMessage.textContent = response.ok && body.success === true
      ? matched ? "The two addresses match." : "The two addresses do not match. Review the details before continuing."
      : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    addressMessage.className = "form-message error";
    addressMessage.textContent = error.message;
  } finally {
    addressButton.disabled = false;
  }
});

cibilForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!document.querySelector("#cibil-consent").checked) return;
  cibilButton.disabled = true;
  cibilMessage.className = "form-message";
  cibilMessage.textContent = "Fetching the CIBIL score from Surepass…";
  cibilResult.hidden = true;
  const values = Object.fromEntries(new FormData(cibilForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/cibil-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    cibilResult.innerHTML = renderCibilBody(body);
    cibilResult.hidden = false;
    cibilMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    cibilMessage.textContent = response.ok && body.success === true
      ? "CIBIL score received successfully."
      : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    cibilMessage.className = "form-message error";
    cibilMessage.textContent = error.message;
  } finally {
    cibilButton.disabled = false;
  }
});

passportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  passportButton.disabled = true;
  passportMessage.className = "form-message";
  passportMessage.textContent = "Checking passport details with Surepass…";
  passportResultDetails.hidden = true;
  const values = Object.fromEntries(new FormData(passportForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/passport-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    passportResult.innerHTML = renderProviderBody(body);
    passportResultDetails.hidden = false;
    passportMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    passportMessage.textContent = response.ok && body.success === true
      ? "Passport details verified successfully."
      : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    passportMessage.className = "form-message error";
    passportMessage.textContent = error.message;
  } finally {
    passportButton.disabled = false;
  }
});

licenseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  licenseButton.disabled = true;
  licenseMessage.className = "form-message";
  licenseMessage.textContent = "Checking the driving licence with Surepass…";
  licenseResultDetails.hidden = true;
  const values = Object.fromEntries(new FormData(licenseForm).entries());
  try {
    const response = await fetch(`${API_BASE_URL}/provider-tests/surepass/driving-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    const body = await response.json();
    licenseResult.innerHTML = renderProviderBody(body);
    licenseResultDetails.hidden = false;
    licenseMessage.className = response.ok && body.success === true ? "form-message success-message" : "form-message error";
    licenseMessage.textContent = response.ok && body.success === true
      ? "Driving licence verified successfully."
      : body.status_code === 422
        ? "The request was received, but Surepass could not verify these details."
        : `Surepass returned HTTP ${body.status_code || response.status}.`;
  } catch (error) {
    licenseMessage.className = "form-message error";
    licenseMessage.textContent = error.message;
  } finally {
    licenseButton.disabled = false;
  }
});

function setQuickResult(messageElement, resultElement, response, body, successText) {
  resultElement.innerHTML = renderProviderBody(body);
  resultElement.hidden = false;
  const ok = response.ok && body?.success === true;
  messageElement.className = ok ? "form-message success-message" : "form-message error";
  messageElement.textContent = ok ? successText : body?.message || `Surepass returned HTTP ${body?.status_code || response.status}.`;
}

function bindMultipartQuickForm(formId, buttonId, messageId, resultId, endpoint, loadingText, successText) {
  const quickForm = document.querySelector(`#${formId}`);
  if (!quickForm) return;
  const button = document.querySelector(`#${buttonId}`);
  const message = document.querySelector(`#${messageId}`);
  const result = document.querySelector(`#${resultId}`);
  quickForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.className = "form-message";
    message.textContent = loadingText;
    result.hidden = true;
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, { method: "POST", body: new FormData(quickForm) });
      const body = await response.json();
      setQuickResult(message, result, response, body, successText);
    } catch (error) {
      message.className = "form-message error";
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function bindJsonQuickForm(formId, buttonId, messageId, resultId, endpoint, loadingText, successText, transform = (values) => values) {
  const quickForm = document.querySelector(`#${formId}`);
  if (!quickForm) return;
  const button = document.querySelector(`#${buttonId}`);
  const message = document.querySelector(`#${messageId}`);
  const result = document.querySelector(`#${resultId}`);
  quickForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.className = "form-message";
    message.textContent = loadingText;
    result.hidden = true;
    try {
      const values = Object.fromEntries(new FormData(quickForm).entries());
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transform(values, quickForm))
      });
      const body = await response.json();
      setQuickResult(message, result, response, body, successText);
    } catch (error) {
      message.className = "form-message error";
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

bindMultipartQuickForm("liveness-form", "liveness-button", "liveness-message", "liveness-result", "/provider-tests/surepass/face-liveness", "Checking whether the selfie is from a live person…", "Face liveness result received.");
bindMultipartQuickForm("face-match-form", "face-match-button", "face-match-message", "face-match-result", "/provider-tests/surepass/face-match", "Comparing the selfie with the ID card…", "Face match result received.");
bindJsonQuickForm("employment-form", "employment-button", "employment-message", "employment-result", "/provider-tests/surepass/employment-history", "Fetching verified employment history…", "Employment history received.");
bindJsonQuickForm("ecourts-form", "ecourts-button", "ecourts-message", "ecourts-result", "/provider-tests/surepass/ecourts/search", "Searching eCourts records…", "Court-record search completed.");
bindJsonQuickForm("rc-v2-form", "rc-v2-button", "rc-v2-message", "rc-v2-result", "/provider-tests/surepass/rc-v2", "Fetching vehicle registration, insurance, PUC and permit details…", "RC V2 vehicle data received.", (values, sourceForm) => ({
  id_number: values.id_number,
  enrich: sourceForm.querySelector('[name="enrich"]').checked
}));
bindJsonQuickForm("cnr-form", "cnr-button", "cnr-message", "cnr-result", "/provider-tests/surepass/ecourts/cnr", "Fetching the case by CNR…", "CNR result received.");
bindJsonQuickForm("court-details-form", "court-details-button", "court-details-message", "court-details-result", "/provider-tests/surepass/ecourts/individual-details", "Fetching the court report…", "Court report response received.");
bindJsonQuickForm("digilocker-form", "digilocker-button", "digilocker-message", "digilocker-result", "/provider-tests/surepass/digilocker/initialize", "Creating a secure DigiLocker session…", "DigiLocker session created.", (values, sourceForm) => ({
  data: {
    signup_flow: sourceForm.querySelector('[name="signup_flow"]').checked,
    aadhaar_xml: sourceForm.querySelector('[name="aadhaar_xml"]').checked,
    prefill_options: {
      full_name: values.full_name || undefined,
      mobile_number: values.mobile_number || undefined
    },
    skip_main_screen: false
  }
}));
