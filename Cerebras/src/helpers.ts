import { CerebrasProtocolError } from './errors.ts';
import type { AssistantMessage, ChatChunk, ChatCompletion, ToolCall } from './types.ts';

/** Tool JSON is untrusted. Validate it before the application authorizes any function execution. */
export function parseToolArguments<T>(call: ToolCall, validate: (value: unknown) => T): T {
  let value: unknown;
  try { value = JSON.parse(call.function.arguments); }
  catch { throw new CerebrasProtocolError('Tool arguments are not valid JSON.'); }
  return validate(value);
}

/** Collects text, reasoning, tool fragments, finish reasons, logprobs and final usage. Memory grows with output. */
export async function collectStream(chunks: AsyncIterable<ChatChunk>): Promise<ChatCompletion> {
  let result: ChatCompletion | undefined;
  const calls = new Map<number, Map<number, Partial<ToolCall>>>();
  for await (const chunk of chunks) {
    result ??= { id: chunk.id, object: 'chat.completion', created: chunk.created, model: chunk.model, choices: [] };
    if (chunk.usage) result.usage = chunk.usage;
    if (chunk.time_info) result.time_info = chunk.time_info;
    if (chunk.system_fingerprint !== undefined) result.system_fingerprint = chunk.system_fingerprint;
    for (const choice of chunk.choices) {
      let target = result.choices.find(item => item.index === choice.index);
      if (!target) { target = { index: choice.index, message: { role: 'assistant', content: '' }, finish_reason: '' }; result.choices.push(target); }
      const delta = choice.delta;
      if (delta.content) target.message.content = (target.message.content ?? '') + delta.content;
      if (delta.reasoning) target.message.reasoning = (target.message.reasoning ?? '') + delta.reasoning;
      if (choice.finish_reason) target.finish_reason = choice.finish_reason;
      if (choice.logprobs) {
        target.logprobs ??= {};
        for (const key of ['content', 'reasoning'] as const) if (choice.logprobs[key]) (target.logprobs[key] ??= []).push(...choice.logprobs[key]);
      }
      if (choice.reasoning_logprobs !== undefined) target.reasoning_logprobs = choice.reasoning_logprobs;
      for (const fragment of delta.tool_calls ?? []) {
        let byIndex = calls.get(choice.index);
        if (!byIndex) { byIndex = new Map(); calls.set(choice.index, byIndex); }
        const call = byIndex.get(fragment.index) ?? { function: { name: '', arguments: '' } };
        if (fragment.id) call.id = (call.id ?? '') + fragment.id;
        if (fragment.type) call.type = fragment.type;
        if (fragment.function?.name) call.function!.name += fragment.function.name;
        if (fragment.function?.arguments) call.function!.arguments += fragment.function.arguments;
        byIndex.set(fragment.index, call);
      }
    }
  }
  if (!result?.choices.length || result.choices.some(choice => !choice.finish_reason)) throw new CerebrasProtocolError('Stream has no complete finished choice.');
  for (const choice of result.choices) {
    const byIndex = calls.get(choice.index);
    if (byIndex?.size) choice.message.tool_calls = [...byIndex].sort(([a], [b]) => a - b).map(([, call]) => {
      if (!call.id || call.type !== 'function' || !call.function?.name) throw new CerebrasProtocolError('Incomplete streamed tool call.');
      return call as ToolCall;
    });
  }
  result.choices.sort((a, b) => a.index - b.index);
  return result;
}

/** Explicit copy of the full assistant fields needed for multi-turn reasoning and tool conversations. */
export function assistantHistory(message: AssistantMessage): AssistantMessage {
  return { role: 'assistant', content: message.content, reasoning: message.reasoning, tool_calls: message.tool_calls?.map(call => ({ ...call, function: { ...call.function } })) };
}
