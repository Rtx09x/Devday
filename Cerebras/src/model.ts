export const QWEN_MODEL = 'qwen-3.8-27b' as const;
/** Snapshot, not an account entitlement or token estimator. Server/account limits remain authoritative. */
export const QWEN_CAPABILITIES = Object.freeze({
  model: QWEN_MODEL,
  verifiedDate: '2026-11-01',
  input: Object.freeze(['text', 'image'] as const),
  output: Object.freeze(['text'] as const),
  imageFormats: Object.freeze(['image/png', 'image/jpeg'] as const),
  imageRoles: Object.freeze(['user'] as const),
  imageInputPublicPreview: true,
  reasoningEfforts: Object.freeze(['none', 'low', 'medium', 'high'] as const),
  reasoningFormats: Object.freeze(['parsed', 'raw', 'none'] as const),
  reasoningDefault: 'high',
  clearThinkingDefault: false,
  streaming: true, tools: true, parallelTools: true, strictSchemas: true, promptCaching: true,
  limits: Object.freeze({
    'free-trial': Object.freeze({ contextTokens: 65_536, maxOutputTokens: 32_768, maxImages: 2 }),
    paid: Object.freeze({ contextTokens: 131_072, maxOutputTokens: 40_960, maxImages: 10 }),
    requestBytes: 10 * 1024 * 1024,
  }),
  sources: Object.freeze({
    model: 'https://inference-docs.cerebras.ai/models/qwen-3.8-27b',
    images: 'https://inference-docs.cerebras.ai/capabilities/image-inputs',
    reasoning: 'https://inference-docs.cerebras.ai/capabilities/reasoning',
    tools: 'https://inference-docs.cerebras.ai/capabilities/tool-use',
    schemas: 'https://inference-docs.cerebras.ai/capabilities/structured-outputs',
    publicCatalog: 'https://api.cerebras.ai/public/v1/models/qwen-3.8-27b',
  }),
});
