export class ExaValidationError extends Error { override name = 'ExaValidationError'; }
export class ExaProtocolError extends Error { override name = 'ExaProtocolError'; }
export class ExaTransportError extends Error { override name = 'ExaTransportError'; }
export class ExaTimeoutError extends Error { override name = 'ExaTimeoutError'; }
export class ExaAPIError extends Error {
  override name = 'ExaAPIError';
  readonly status: number;
  readonly requestId?: string;
  constructor(status: number, requestId?: string) {
    super(`Exa request failed (HTTP ${status}).`);
    this.status = status;
    this.requestId = requestId;
  }
}
