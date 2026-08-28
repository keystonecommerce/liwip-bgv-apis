export type AadhaarOvseChannel = "qr" | "app" | "web";
export type AadhaarOvseAuthMode = "0" | "1";

export interface AadhaarOvseInitializeData {
  channel?: AadhaarOvseChannel;
  claims?: string[];
  auth_mode?: AadhaarOvseAuthMode;
  language?: string;
  hint?: string;
  app_signature?: string;
  webhook_url?: string;
  redirect_url?: string;
  reference_id?: string;
}

export interface AadhaarOvseInitializeProviderData {
  client_id: string;
  qr_data?: string | null;
  intent_data?: string;
  channel?: AadhaarOvseChannel;
  status?: string;
  web_link?: string | null;
}

export interface AadhaarOvseInitializeProviderResponse {
  data?: AadhaarOvseInitializeProviderData | null;
  status_code?: number;
  message?: string;
  message_code?: string;
  success?: boolean;
}

export type AadhaarOvseStatus = "pending" | "callback_received" | "completed" | "failed" | "expired";

export interface AadhaarOvseStatusProviderResponse {
  data?: {
    client_id?: string;
    status?: AadhaarOvseStatus;
    status_description?: string;
  } | null;
  status_code?: number;
  message?: string;
  message_code?: string;
  success?: boolean;
}

export interface AadhaarOvseResultData {
  client_id?: string;
  status?: string;
  full_name?: string;
  local_name?: string;
  dob?: string;
  gender?: string;
  profile_image?: string;
  has_image?: boolean;
  address?: Record<string, unknown>;
  full_address?: string;
  pincode?: string;
  care_of?: string;
  mobile?: string;
  masked_mobile?: string;
  email_address?: string;
  masked_email?: string;
  age_above_18?: boolean;
  age_above_50?: boolean;
  age_above_60?: boolean;
  age_above_75?: boolean;
  is_nri?: boolean;
  enrolment_number?: string;
}

export interface AadhaarOvseResultProviderResponse {
  data?: AadhaarOvseResultData | null;
  status_code?: number;
  message?: string;
  message_code?: string;
  success?: boolean;
}
