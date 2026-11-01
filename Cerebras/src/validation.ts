import { Buffer } from 'node:buffer';
import { CerebrasValidationError } from './errors.ts';
import { validateImage } from './images.ts';
import { QWEN_CAPABILITIES, QWEN_MODEL } from './model.ts';
import type { ChatRequest, ClientOptions, ImagePart, JsonSchema } from './types.ts';

const allowed = new Set('messages model reasoning_effort reasoning_format clear_thinking max_completion_tokens min_completion_tokens temperature top_p seed stop frequency_penalty presence_penalty logit_bias logprobs top_logprobs n tools tool_choice parallel_tool_calls response_format prompt_cache_key user'.split(' '));
function fail(message: string): never { throw new CerebrasValidationError(message); }
function range(value: unknown, low: number, high: number, name: string, integer = false): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) fail(`Invalid ${name}.`);
}

/** Fast contract checks; the server remains the authoritative JSON Schema validator. */
export function validateStrictSchema(schema: JsonSchema): void {
  if (!schema || schema.type !== 'object' || !schema.properties || schema.anyOf) fail('Strict schemas require an object root with properties.');
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) fail('Cyclic schema objects are unsupported.');
    visited.add(value);
    const node = value as Record<string, unknown>;
    if (node.type === 'object' || node.properties) {
      if (node.additionalProperties !== false) fail('Every strict schema object requires additionalProperties: false.');
    }
    for (const key of ['oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'unevaluatedProperties', 'pattern', 'format', 'minItems', 'maxItems', 'minLength', 'maxLength', 'nullable', '$anchor']) {
      if (key in node) fail(`Unsupported strict schema keyword: ${key}.`);
    }
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#/')) fail('Only local nonrecursive schema references are supported.');
    if (node.type === 'array' && !(node.items && typeof node.items === 'object') && !(node.items === false && Array.isArray(node.prefixItems))) fail('Strict arrays require an item schema or prefixItems with items: false.');
    if (Array.isArray(node.items)) fail('Use prefixItems instead of array-form items.');
    // Only traverse schema positions, not annotation/default/enum data.
    for (const key of ['properties', '$defs', 'definitions']) {
      const map = node[key];
      if (map && typeof map === 'object') for (const child of Object.values(map)) visit(child);
    }
    if (node.items && typeof node.items === 'object') visit(node.items);
    for (const key of ['anyOf', 'prefixItems']) if (Array.isArray(node[key])) for (const child of node[key]) visit(child);
    visited.delete(value);
  };
  visit(schema);
}

export function prepareRequest(request: ChatRequest, stream: boolean, capacity: NonNullable<ClientOptions['capacity']>): string {
  const limits = QWEN_CAPABILITIES.limits[capacity];
  for (const key of Object.keys(request)) if (!allowed.has(key)) fail(`Unsupported request parameter: ${key}.`);
  if (request.model !== undefined && request.model !== QWEN_MODEL) fail(`This integration targets ${QWEN_MODEL} only.`);
  if (!Array.isArray(request.messages) || request.messages.length === 0) fail('At least one conversation message is required.');
  if (request.reasoning_effort !== undefined && !QWEN_CAPABILITIES.reasoningEfforts.includes(request.reasoning_effort)) fail('Unsupported Qwen reasoning effort.');
  if (request.reasoning_format !== undefined && !QWEN_CAPABILITIES.reasoningFormats.includes(request.reasoning_format)) fail('Unsupported Qwen reasoning format; hidden is unavailable.');
  for (const key of ['clear_thinking', 'parallel_tool_calls', 'logprobs'] as const) if (request[key] !== undefined && typeof request[key] !== 'boolean') fail(`Invalid ${key}.`);
  range(request.max_completion_tokens, 1, limits.maxOutputTokens, 'max_completion_tokens', true);
  range(request.min_completion_tokens, -1, limits.maxOutputTokens, 'min_completion_tokens', true);
  if (request.min_completion_tokens !== undefined && request.max_completion_tokens !== undefined && request.min_completion_tokens > request.max_completion_tokens) fail('Minimum completion tokens cannot exceed the maximum.');
  range(request.temperature, 0, 2, 'temperature'); range(request.top_p, 0, 1, 'top_p');
  range(request.frequency_penalty, -2, 2, 'frequency_penalty'); range(request.presence_penalty, -2, 2, 'presence_penalty');
  range(request.seed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'seed', true);
  range(request.top_logprobs, 0, 20, 'top_logprobs', true);
  if (request.top_logprobs !== undefined && !request.logprobs) fail('top_logprobs requires logprobs: true.');
  if (request.n !== undefined && request.n !== 1) fail('Cerebras supports only n: 1.');
  if (request.stop !== undefined && !(typeof request.stop === 'string' || (Array.isArray(request.stop) && request.stop.length <= 4 && request.stop.every(x => typeof x === 'string')))) fail('stop must contain up to four strings.');
  if (request.logit_bias) for (const [token, bias] of Object.entries(request.logit_bias)) {
    if (!/^\d+$/.test(token)) fail('logit_bias keys must be token IDs.');
    range(bias, -100, 100, 'logit_bias');
  }
  if (request.prompt_cache_key !== undefined && (typeof request.prompt_cache_key !== 'string' || request.prompt_cache_key.length > 1024)) fail('prompt_cache_key must be a string of at most 1024 characters.');
  if (request.response_format && !['text', 'json_object', 'json_schema'].includes(request.response_format.type)) fail('Unsupported response format.');
  if (stream && request.response_format?.type === 'json_object') fail('Legacy json_object mode cannot stream. Use json_schema.');
  if (request.tools?.length && request.response_format && request.response_format.type !== 'text') fail('Use separate tool-calling and structured-output requests; their combination is not a documented Qwen contract.');
  if (request.tool_choice !== undefined && !request.tools?.length) fail('tool_choice requires tools.');
  const toolNames = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (tool.type !== 'function' || !/^[\w-]{1,64}$/.test(tool.function.name) || toolNames.has(tool.function.name)) fail('Function tools need unique names of at most 64 letters, digits, underscores or hyphens.');
    toolNames.add(tool.function.name);
    if (tool.function.strict) validateStrictSchema(tool.function.parameters);
  }
  if (typeof request.tool_choice === 'string' && !['none', 'auto', 'required'].includes(request.tool_choice)) fail('Unsupported tool_choice.');
  if (typeof request.tool_choice === 'object' && (request.tool_choice.type !== 'function' || !toolNames.has(request.tool_choice.function.name))) fail('Named tool_choice must reference a supplied function.');
  if (request.response_format?.type === 'json_schema' && request.response_format.json_schema.strict) validateStrictSchema(request.response_format.json_schema.schema);
  let images = 0;
  const pending = new Set<string>(), allIds = new Set<string>();
  for (const message of request.messages) {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) fail('Unsupported message role.');
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) fail('Tool messages require a unique immediately preceding assistant tool-call ID.');
    } else if (pending.size) fail('Every assistant tool call needs a tool result immediately following it.');
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string') continue;
        if (part.type === 'image_url' && message.role === 'user') { validateImage(part as ImagePart); images++; }
        else fail('Only user messages support image parts; other content must be text.');
      }
    } else if (typeof message.content !== 'string' && !(message.role === 'assistant' && message.tool_calls?.length && message.content == null)) fail('Message content must be text or valid content parts.');
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
      if (!call.id || allIds.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') fail('Invalid or duplicate assistant tool call.');
      allIds.add(call.id); pending.add(call.id);
    }
  }
  if (pending.size) fail('Every assistant tool call requires its tool result before continuing.');
  if (images > limits.maxImages) fail(`Selected capacity permits at most ${limits.maxImages} images per request.`);
  let body: string;
  try { body = JSON.stringify({ ...request, model: QWEN_MODEL, stream }); } catch { fail('Request must be JSON serializable.'); }
  if (Buffer.byteLength(body, 'utf8') > QWEN_CAPABILITIES.limits.requestBytes) fail('Request exceeds the 10 MiB Shared Inference payload limit.');
  return body;
}
