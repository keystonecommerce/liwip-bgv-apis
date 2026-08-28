export interface Msg91ApiResponse {
  type?: string;
  message?: string;
  request_id?: string;
  success?: boolean;
  [key: string]: unknown;
}

export class Msg91ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response: Msg91ApiResponse | null = null
  ) {
    super(message);
    this.name = "Msg91ProviderError";
  }
}
