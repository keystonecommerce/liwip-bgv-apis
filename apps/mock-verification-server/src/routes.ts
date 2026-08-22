import { Router } from "express";
import { respondWithScenario } from "./scenario-handler";

const router = Router();

router.post("/aadhaar", async (req, res) => {
  const { name, dateOfBirth, aadhaarReference } = req.body ?? {};
  if (!name || !dateOfBirth) return res.status(400).json({ error: "VALIDATION_ERROR", message: "name and dateOfBirth are required" });
  return respondWithScenario(req, res, { nameMatch: true, dobMatch: true, aadhaarReferenceValid: Boolean(aadhaarReference) });
});

router.post("/driving-license", async (req, res) => {
  const { licenseNumber, name, dob } = req.body ?? {};
  if (!licenseNumber || !name || !dob) return res.status(400).json({ error: "VALIDATION_ERROR", message: "licenseNumber, name and dob are required" });
  return respondWithScenario(req, res, { nameMatch: true, dobMatch: true, licenseValid: true, licenseNumber });
});

router.post("/pan", async (req, res) => {
  const { idNumber } = req.body ?? {};
  if (!idNumber) return res.status(400).json({ error: "VALIDATION_ERROR", message: "idNumber is required" });
  return respondWithScenario(req, res, { panValid: true, pan: idNumber });
});

router.post("/voter-id", async (req, res) => {
  const { idNumber, fullName, dob } = req.body ?? {};
  if (!idNumber || !fullName || !dob) return res.status(400).json({ error: "VALIDATION_ERROR", message: "idNumber, fullName and dob are required" });
  return respondWithScenario(req, res, { voterIdValid: true, voterId: idNumber, nameMatch: true, dobMatch: true });
});

router.post("/address-matching", async (req, res) => {
  const { address1, address2 } = req.body ?? {};
  if (!address1 || !address2) return res.status(400).json({ error: "VALIDATION_ERROR", message: "address1 and address2 are required" });
  return respondWithScenario(req, res, { addressMatch: true, matchScore: 100 });
});

router.post("/education", async (req, res) => {
  const { name, qualification, courseName } = req.body ?? {};
  if (!name || !qualification) return res.status(400).json({ error: "VALIDATION_ERROR", message: "name and qualification are required" });
  return respondWithScenario(req, res, { nameMatch: true, qualificationMatch: true, qualification, courseName: courseName || null });
});

router.post("/rc-full", async (req, res) => {
  const { idNumber } = req.body ?? {};
  if (!idNumber) return res.status(400).json({ error: "VALIDATION_ERROR", message: "idNumber is required" });
  return respondWithScenario(req, res, { registrationNumber: idNumber, vehicleValid: true, ownerMatch: true });
});

router.post("/rc-v2", async (req, res) => {
  const { idNumber } = req.body ?? {};
  if (!idNumber) return res.status(400).json({ error: "VALIDATION_ERROR", message: "idNumber is required" });
  return respondWithScenario(req, res, {
    rc_number: idNumber,
    rc_status: "ACTIVE",
    owner_name: "MOCK OWNER",
    insurance_upto: "2030-12-31",
    pucc_upto: "2030-12-31",
    fit_up_to: "2030-12-31",
    permit_valid_upto: "2030-12-31",
    permit_type: "Commercial",
    blacklist_status: "clear"
  });
});

router.post("/cibil-score", async (req, res) => {
  const { pan, mobile, name, gender } = req.body ?? {};
  if (!pan || !mobile || !name || !gender) return res.status(400).json({ error: "VALIDATION_ERROR", message: "pan, mobile, name and gender are required" });
  return respondWithScenario(req, res, { pan, mobile, name, gender, credit_score: 742 });
});

router.post("/passport-details", async (req, res) => {
  const { fileNumber, dob } = req.body ?? {};
  if (!fileNumber || !dob) return res.status(400).json({ error: "VALIDATION_ERROR", message: "fileNumber and dob are required" });
  return respondWithScenario(req, res, { fileNumber, dob, passportValid: true, nameMatch: true });
});

router.post("/face-liveness", async (req, res) => {
  return respondWithScenario(req, res, { live: true, confidence: 9 });
});

router.post("/face-match", async (req, res) => {
  return respondWithScenario(req, res, { match_status: true, confidence: 92 });
});

router.post("/employment-history", async (req, res) => {
  const { uan } = req.body ?? {};
  if (!uan) return res.status(400).json({ error: "VALIDATION_ERROR", message: "uan is required" });
  return respondWithScenario(req, res, { uan, employment_history: [{ establishment_name: "Mock Employer", date_of_joining: "2021-01-01", date_of_exit: null }] });
});

router.post("/ecourts-search", async (req, res) => {
  const { name, fatherName, address } = req.body ?? {};
  if (!name || !fatherName || !address) return res.status(400).json({ error: "VALIDATION_ERROR", message: "name, fatherName and address are required" });
  return respondWithScenario(req, res, { name, fatherName, address, result: [] });
});

export default router;
