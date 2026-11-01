/** All plugin mutations pass through the same authoritative broker as the workspace. */
export class BrokerError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
export class BrokerClient {
  readonly baseUrl: string;
  constructor(
    url = process.env.CUTUCIRCUITS_URL ?? "http://127.0.0.1:4310",
    private readonly signal?: AbortSignal,
  ) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw new Error(
        "CUTUCIRCUITS_URL must be an HTTP(S) URL without credentials, query, or fragment",
      );
    this.baseUrl = parsed.href.replace(/\/$/, "");
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
        redirect: "error",
      });
    } catch (error) {
      throw new BrokerError(
        "RUNTIME_UNREACHABLE",
        `Cannot reach Cutu Circuits at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}. Start the local runtime from the Cutu Circuits repository with npm start (or npm run dev for development).`,
      );
    }
    const raw = await response.text();
    let result: any;
    try {
      result = raw ? JSON.parse(raw) : null;
    } catch {
      throw new BrokerError(
        "INVALID_RESPONSE",
        `Runtime returned non-JSON (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok)
      throw new BrokerError(
        result?.error?.code ?? "HTTP_ERROR",
        result?.error?.message ??
          `Runtime request failed (HTTP ${response.status}).`,
        response.status,
      );
    return result;
  }
}
export const projectPath = (id: string) =>
  `/api/projects/${encodeURIComponent(id)}`;
