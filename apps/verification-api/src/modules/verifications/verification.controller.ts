import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { ApplicationSchema } from "../../domain/verification.types";
import { InternalRouteGuard } from "../../common/auth/internal-route.guard";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";
import { VerificationService } from "./verification.service";

@Controller()
@UseGuards(InternalRouteGuard)
export class VerificationController {
  constructor(
    @Inject(VerificationService) private readonly verificationService: VerificationService,
    @Inject(SurepassProvider) private readonly provider: SurepassProvider
  ) {}

  @Post("applications")
  createApplication(@Body() data: ApplicationSchema) {
    return this.verificationService.createApplication(data);
  }

  @Get("applications/:id/verifications")
  getApplication(@Param("id") id: string) { return this.verificationService.getApplicationDetails(id); }

  @Get("worker/packages")
  listPackages() { return this.verificationService.listPackages(); }

  @Post("verifications/:id/retry")
  retryVerification(@Param("id") id: string) { return this.verificationService.retryVerification(id); }

  @Post("worker-verifications")
  @UseInterceptors(FileFieldsInterceptor([
    { name: "aadhaar_file", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
    { name: "id_card", maxCount: 1 }
  ], { limits: { fileSize: 10 * 1024 * 1024 } }))
  async createWorkerVerification(
    @UploadedFiles() files: Record<string, Array<{ buffer: Buffer; originalname: string; mimetype: string }>> | undefined,
    @Body() payload: {
      package_code?: string;
      name?: string;
      dob?: string;
      mobile?: string;
      pan?: string;
      driving_license?: string;
      driving_license_dob?: string;
      voter_id?: string;
      father_name?: string;
      uan?: string;
      employer_name?: string;
      reference_name?: string;
      reference_phone?: string;
      reference_relationship?: string;
      skill_certification?: string;
      certificate_reference?: string;
      criminal_consent?: string;
      criminal_year?: string;
      criminal_state?: string;
      gender?: string;
      vehicle_registration_number?: string;
      passport_file_number?: string;
      credit_consent?: string;
      submitted_address?: string;
      consent?: string;
      address_consent?: string;
      biometric_consent?: string;
    }
  ) {
    const file = files?.aadhaar_file?.[0];
    const selfie = files?.selfie?.[0];
    const idCard = files?.id_card?.[0];
    const required = [payload?.name, payload?.dob, payload?.mobile];
    if (required.some((value) => !String(value || "").trim())) {
      throw new BadRequestException("name, dob, and mobile are required");
    }
    if (file?.buffer && !file.originalname?.toLowerCase().endsWith(".pdf") && file.mimetype !== "application/pdf") {
      throw new BadRequestException("The Aadhaar document must be a PDF");
    }
    if ((selfie || idCard) && (!selfie || !idCard)) {
      throw new BadRequestException("Upload both a selfie and an ID card for face verification");
    }
    if ((selfie || idCard) && payload.biometric_consent !== "Y") {
      throw new BadRequestException("Biometric consent is required for face verification");
    }
    if (payload.uan && !/^\d{12}$/.test(payload.uan)) throw new BadRequestException("uan must be a 12-digit number");
    if (payload.criminal_consent === "Y" && (!payload.father_name?.trim() || !payload.submitted_address?.trim())) {
      throw new BadRequestException("father_name and submitted_address are required for the court-record check");
    }
    if (payload.consent !== "Y") throw new BadRequestException("Identity verification consent is required");
    if ((payload.submitted_address || file) && payload.address_consent !== "Y") throw new BadRequestException("Address consent is required when an address or Aadhaar document is submitted");
    if (payload.pan && !/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(payload.pan)) throw new BadRequestException("pan must match the format ABCDE1234F");
    if (!/^\d{10}$/.test(payload.mobile!)) throw new BadRequestException("mobile must be a 10-digit number");
    if (payload.gender && !["male", "female"].includes(payload.gender)) throw new BadRequestException("gender must be male or female");
    if (payload.credit_consent === "Y" && !payload.gender) throw new BadRequestException("gender is required for a CIBIL check");

    return this.verificationService.createApplication({
      packageCode: payload.package_code?.trim().toUpperCase() || "BASIC_ID",
      personal: {
        phone: payload.mobile!,
        nameAsAadhaar: payload.name!.trim(),
        dateOfBirth: payload.dob!,
        panNumber: payload.pan?.trim().toUpperCase() || undefined,
        drivingLicenceNumber: payload.driving_license?.trim() || undefined,
        drivingLicenceDob: payload.driving_license ? payload.driving_license_dob || payload.dob : undefined,
        voterId: payload.voter_id?.trim() || undefined,
        gender: payload.gender || undefined,
        passportFileNumber: payload.passport_file_number?.trim() || undefined,
        submittedAddress: payload.submitted_address?.trim() || undefined
      },
      employment: payload.uan || payload.employer_name?.trim() ? {
        uan: payload.uan?.trim() || undefined,
        employerName: payload.employer_name?.trim() || undefined
      } : undefined,
      references: payload.reference_name?.trim() ? [{
        name: payload.reference_name.trim(),
        phone: payload.reference_phone?.trim() || undefined,
        relationship: payload.reference_relationship?.trim() || undefined
      }] : undefined,
      skills: payload.skill_certification?.trim() || payload.certificate_reference?.trim() ? {
        certificationName: payload.skill_certification?.trim() || undefined,
        certificateReference: payload.certificate_reference?.trim() || undefined
      } : undefined,
      criminal: payload.criminal_consent === "Y" ? {
        fatherName: payload.father_name?.trim(),
        year: payload.criminal_year?.trim() || undefined,
        state: payload.criminal_state?.trim() || undefined,
        consent: true
      } : undefined,
      vehicle: payload.vehicle_registration_number?.trim()
        ? { registrationNumber: payload.vehicle_registration_number.trim().toUpperCase() }
        : undefined,
      documents: file?.buffer || selfie?.buffer || idCard?.buffer ? {
        ...(file?.buffer ? { aadhaarPdf: { fileName: file.originalname } } : {}),
        ...(selfie?.buffer ? { selfie: { fileName: selfie.originalname } } : {}),
        ...(idCard?.buffer ? { idCard: { fileName: idCard.originalname } } : {})
      } : undefined,
      consent: {
        granted: true,
        purpose: "Gig-worker identity and address verification",
        textVersion: "worker-verification-v1",
        grantedAt: new Date().toISOString()
      },
      ...(payload.credit_consent === "Y" ? {
        creditConsent: {
          granted: true,
          purpose: "CIBIL credit-score verification",
          textVersion: "worker-credit-verification-v1",
          grantedAt: new Date().toISOString()
        }
      } : {})
    }, file?.buffer || selfie?.buffer || idCard?.buffer ? {
      ...(file?.buffer ? { aadhaarPdf: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        fullName: payload.name!.trim(),
        yearOfBirth: payload.dob!.slice(0, 4)
      } } : {}),
      ...(selfie?.buffer ? { selfie: { buffer: selfie.buffer, originalname: selfie.originalname, mimetype: selfie.mimetype } } : {}),
      ...(idCard?.buffer ? { idCard: { buffer: idCard.buffer, originalname: idCard.originalname, mimetype: idCard.mimetype } } : {})
    } : undefined);
  }

  @Post("provider-tests/surepass/gst")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  async testSurepassGst(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    if (!file?.buffer) throw new BadRequestException("Upload a GST certificate using the file field");
    const provider = this.provider;
    const result = await provider.verifyGst(file);
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/aadhaar/eaadhaar")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  async testSurepassEaadhaar(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Body() payload: { yob?: string; full_name?: string },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!file?.buffer) throw new BadRequestException("Upload an e-Aadhaar PDF using the file field");
    if (!file.originalname?.toLowerCase().endsWith(".pdf") && file.mimetype !== "application/pdf") {
      throw new BadRequestException("The Aadhaar document must be a PDF");
    }
    if (!payload?.yob || !/^\d{4}$/.test(payload.yob)) throw new BadRequestException("yob must be a four-digit year");
    if (!payload?.full_name?.trim()) throw new BadRequestException("full_name is required");

    const provider = this.provider;
    const result = await provider.verifyEaadhaar({
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      fullName: payload.full_name,
      yearOfBirth: payload.yob
    });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/driving-license")
  async testSurepassDrivingLicense(@Body() payload: { id_number?: string; dob?: string }, @Res({ passthrough: true }) response: Response) {
    if (!payload?.id_number || !payload?.dob) {
      throw new BadRequestException("id_number and dob are required");
    }
    const provider = this.provider;
    const result = await provider.verifyDrivingLicense({ idNumber: payload.id_number, dob: payload.dob });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/pan")
  async testSurepassPan(@Body() payload: { id_number?: string; masked_aadhaar_variant?: string }, @Res({ passthrough: true }) response: Response) {
    if (!payload?.id_number) {
      throw new BadRequestException("id_number is required");
    }
    const provider = this.provider;
    const result = await provider.verifyPanComprehensive({ idNumber: payload.id_number, maskedAadhaarVariant: payload.masked_aadhaar_variant });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/voter-id")
  async testSurepassVoterId(
    @Body() payload: { id_number?: string; full_name?: string; dob?: string },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.id_number || !payload?.full_name || !payload?.dob) {
      throw new BadRequestException("id_number, full_name, and dob are required");
    }
    const provider = this.provider;
    const result = await provider.verifyVoterId({
      idNumber: payload.id_number,
      fullName: payload.full_name,
      dob: payload.dob
    });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/rc-full")
  async testSurepassRcFull(@Body() payload: { id_number?: string }, @Res({ passthrough: true }) response: Response) {
    if (!payload?.id_number) throw new BadRequestException("id_number is required");
    const provider = this.provider;
    const result = await provider.verifyRcFull({ idNumber: payload.id_number });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/rc-v2")
  async testSurepassRcV2(
    @Body() payload: { id_number?: string; enrich?: boolean },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.id_number?.trim()) throw new BadRequestException("id_number is required");
    const provider = this.provider;
    const result = await provider.verifyRcV2({ idNumber: payload.id_number.trim().toUpperCase(), enrich: payload.enrich === true });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/address-matching")
  async testSurepassAddressMatching(
    @Body() payload: { address_1?: string; address_2?: string },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.address_1?.trim() || !payload?.address_2?.trim()) {
      throw new BadRequestException("address_1 and address_2 are required");
    }
    const provider = this.provider;
    const result = await provider.matchAddresses({ address1: payload.address_1, address2: payload.address_2 });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/cibil-score")
  async testSurepassCibilScore(
    @Body() payload: { pan?: string; mobile?: string; name?: string; gender?: "male" | "female" },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.pan || !payload?.mobile || !payload?.name || !payload?.gender) {
      throw new BadRequestException("pan, mobile, name, and gender are required");
    }
    if (!/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(payload.pan)) {
      throw new BadRequestException("pan must match the format ABCDE1234F");
    }
    if (!/^\d{10}$/.test(payload.mobile)) {
      throw new BadRequestException("mobile must be a 10-digit number");
    }
    const provider = this.provider;
    const result = await provider.verifyCibilScore({
      pan: payload.pan,
      mobile: payload.mobile,
      name: payload.name,
      gender: payload.gender
    });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/passport-details")
  async testSurepassPassportDetails(
    @Body() payload: { file_number?: string; dob?: string },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.file_number || !payload?.dob) {
      throw new BadRequestException("file_number and dob are required");
    }
    const provider = this.provider;
    const result = await provider.verifyPassportDetails({ fileNumber: payload.file_number, dob: payload.dob });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/face-liveness")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  async testSurepassFaceLiveness(
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string } | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    if (!file?.buffer) throw new BadRequestException("Upload a selfie using the file field");
    const provider = this.provider;
    const result = await provider.verifyFaceLiveness(file);
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/face-match")
  @UseInterceptors(FileFieldsInterceptor([
    { name: "selfie", maxCount: 1 },
    { name: "id_card", maxCount: 1 },
    { name: "selfie_2", maxCount: 1 }
  ], { limits: { fileSize: 10 * 1024 * 1024 } }))
  async testSurepassFaceMatch(
    @UploadedFiles() files: Record<string, Array<{ buffer: Buffer; originalname: string; mimetype: string }>> | undefined,
    @Res({ passthrough: true }) response: Response
  ) {
    const selfie = files?.selfie?.[0];
    const idCard = files?.id_card?.[0];
    if (!selfie?.buffer || !idCard?.buffer) throw new BadRequestException("Upload both selfie and id_card files");
    const provider = this.provider;
    const result = await provider.verifyFaceMatch({ selfie, idCard, selfie2: files?.selfie_2?.[0] });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/employment-history")
  async testSurepassEmploymentHistory(@Body() payload: { id_number?: string }, @Res({ passthrough: true }) response: Response) {
    if (!payload?.id_number || !/^\d{12}$/.test(payload.id_number)) throw new BadRequestException("id_number must be a 12-digit UAN");
    const provider = this.provider;
    const result = await provider.verifyEmploymentHistory({ uan: payload.id_number });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/current-employment")
  async testSurepassCurrentEmployment(
    @Body() payload: {
      pan_number?: string;
      mobile_number?: string;
      uan_number?: string;
      employer_name?: string;
      employee_name?: string;
    },
    @Res({ passthrough: true }) response: Response
  ) {
    const panNumber = payload?.pan_number?.trim().toUpperCase();
    const mobileNumber = payload?.mobile_number?.trim();
    const uanNumber = payload?.uan_number?.trim();
    if (!panNumber && !mobileNumber && !uanNumber) {
      throw new BadRequestException("At least one of pan_number, mobile_number, or uan_number is required");
    }
    if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) {
      throw new BadRequestException("pan_number must match the format ABCDE1234F");
    }
    if (mobileNumber && !/^\d{10}$/.test(mobileNumber)) {
      throw new BadRequestException("mobile_number must be a 10-digit number");
    }
    if (uanNumber && !/^\d{12}$/.test(uanNumber)) {
      throw new BadRequestException("uan_number must be a 12-digit number");
    }
    const result = await this.provider.verifyCurrentEmployment({
      panNumber,
      mobileNumber,
      uanNumber,
      employerName: payload.employer_name?.trim() || undefined,
      employeeName: payload.employee_name?.trim() || undefined
    });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/ecourts/search")
  async testSurepassEcourtsSearch(
    @Body() payload: { name?: string; father_name?: string; address?: string; year?: string; state?: string },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.name?.trim() || !payload?.father_name?.trim() || !payload?.address?.trim()) {
      throw new BadRequestException("name, father_name, and address are required");
    }
    const provider = this.provider;
    const result = await provider.searchEcourts({ name: payload.name, fatherName: payload.father_name, address: payload.address, year: payload.year, state: payload.state });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/ecourts/individual-details")
  async testSurepassEcourtIndividualDetails(@Body() payload: { client_id?: string }, @Res({ passthrough: true }) response: Response) {
    if (!payload?.client_id?.trim()) throw new BadRequestException("client_id is required");
    const provider = this.provider;
    const result = await provider.getEcourtIndividualDetails({ clientId: payload.client_id });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/ecourts/cnr")
  async testSurepassEcourtCnr(
    @Body() payload: { cnr_number?: string; court_type?: "district_court" | "high_court" },
    @Res({ passthrough: true }) response: Response
  ) {
    if (!payload?.cnr_number || !/^[A-Za-z0-9]{16}$/.test(payload.cnr_number)) throw new BadRequestException("cnr_number must be a 16-character alphanumeric CNR");
    if (!payload.court_type || !["district_court", "high_court"].includes(payload.court_type)) throw new BadRequestException("court_type must be district_court or high_court");
    const provider = this.provider;
    const result = await provider.searchEcourtByCnr({ cnrNumber: payload.cnr_number, courtType: payload.court_type });
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }

  @Post("provider-tests/surepass/digilocker/initialize")
  async testSurepassDigiLocker(@Body() payload: { data?: Record<string, unknown> }, @Res({ passthrough: true }) response: Response) {
    const data = payload?.data || {};
    if (data.signup_flow !== true && data.signup_flow !== false) throw new BadRequestException("data.signup_flow must be true or false");
    const provider = this.provider;
    const result = await provider.initializeDigiLocker(data);
    response.status(result.statusCode);
    return result.body || { status_code: result.statusCode, success: false, message: "Surepass returned an empty response" };
  }
}
