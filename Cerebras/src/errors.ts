export class CerebrasValidationError extends Error { override name = 'CerebrasValidationError' }
/** Does not retain request bodies, keys, raw server messages or raw response bodies. */
export class CerebrasAPIError extends Error {
  override name = 'CerebrasAPIError';
  readonly status: number;
  readonly requestId?: string;
  constructor(status: number, requestId?: string) {
    super(`Cerebras request failed (HTTP ${status}).`);
    this.status = status; this.requestId = requestId;
  }
}
export class CerebrasProtocolError extends Error { override name = 'CerebrasProtocolError' }
export class CerebrasTransportError extends Error {
  override name = 'CerebrasTransportError';
  constructor() { super('Cerebras transport failed. Check connectivity and endpoint configuration.'); }
}
export class CerebrasTimeoutError extends Error {
  override name = 'CerebrasTimeoutError';
  constructor() { super('Cerebras request deadline exceeded.'); }
}
