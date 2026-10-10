export interface DigiLockerPrefillOptions {
  full_name?: string;
  mobile_number?: string;
  user_email?: string;
}

export interface DigiLockerInitializeData {
  prefill_options?: DigiLockerPrefillOptions;
  signup_flow: boolean;
  auth_type?: "web" | "app";
  verify_phone?: boolean;
  verify_email?: boolean;
  allow_selection?: boolean;
  redirect_url?: string;
  webhook_url?: string;
  state?: string;
  local_frontend_url?: string;
  aadhaar_xml?: boolean;
  send_sms?: boolean;
  send_email?: boolean;
  expiry_minutes?: number;
  voice_assistant?: boolean;
  voice_assistant_lang?: "hi" | "en" | "both";
  retry_count?: number;
  skip_main_screen?: boolean;
  logo_url?: string;
}

export interface DigiLockerInitializeProviderData {
  client_id: string;
  token: string;
  url: string;
  expiry_seconds: number;
}

export interface DigiLockerInitializeProviderResponse {
  data?: DigiLockerInitializeProviderData | null;
  status_code?: number;
  message_code?: string;
  message?: string;
  success?: boolean;
}
