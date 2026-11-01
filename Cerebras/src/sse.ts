import { CerebrasProtocolError } from './errors.ts';
import type { ChatChunk } from './types.ts';

/** SSE decoding is independent of network chunk boundaries, CR/LF boundaries and UTF-8 boundaries. */
export async function* decodeSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], event = '', done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const parse = (): ChatChunk | 'done' | undefined => {
    if (!data.length) { event = ''; return; }
    const payload = data.join('\n'); data = [];
    if (payload === '[DONE]') { event = ''; return 'done'; }
    if (event === 'error') throw new CerebrasProtocolError('Cerebras returned a streaming error event.');
    event = '';
    let value: unknown;
    try { value = JSON.parse(payload); } catch { throw new CerebrasProtocolError('Invalid JSON in Cerebras SSE event.'); }
    if (!value || typeof value !== 'object' || 'error' in value || !('choices' in value) || !Array.isArray(value.choices)) throw new CerebrasProtocolError('Invalid Cerebras streaming chunk.');
    return value as ChatChunk;
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const read = await reader.read();
      signal.throwIfAborted();
      try { buffer += decoder.decode(read.value, { stream: !read.done }); }
      catch { throw new CerebrasProtocolError('Invalid UTF-8 in Cerebras SSE stream.'); }
      while (true) {
        const match = /[\r\n]/.exec(buffer);
        if (!match) break;
        const index = match.index;
        // Wait for a possible LF after a trailing CR.
        if (buffer[index] === '\r' && index === buffer.length - 1 && !read.done) break;
        const line = buffer.slice(0, index);
        if (line.length + data.reduce((sum, item) => sum + item.length, 0) > 2 * 1024 * 1024) throw new CerebrasProtocolError('Cerebras SSE event exceeds the 2 MiB client safety limit.');
        buffer = buffer.slice(index + (buffer.slice(index, index + 2) === '\r\n' ? 2 : 1));
        if (line === '') {
          const parsed = parse();
          if (parsed === 'done') { done = true; return; }
          if (parsed) yield parsed;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') data.push(value);
          if (field === 'event') event = value;
        }
      }
      if (buffer.length + data.reduce((sum, line) => sum + line.length, 0) > 2 * 1024 * 1024) throw new CerebrasProtocolError('Cerebras SSE event exceeds the 2 MiB client safety limit.');
      if (read.done) break;
    }
    if (!done) throw new CerebrasProtocolError('Cerebras stream ended before the [DONE] sentinel.');
  } finally {
    signal.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* Resource release must not mask the original error. */ }
    reader.releaseLock();
  }
}
