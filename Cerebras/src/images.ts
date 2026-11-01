import { Buffer } from 'node:buffer';
import { CerebrasValidationError } from './errors.ts';
import type { ImagePart } from './types.ts';

/** Encodes bytes already obtained with application permission. Never reads files or fetches URLs. */
export function imageFromBytes(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): ImagePart {
  if (!bytes.length) throw new CerebrasValidationError('Image bytes cannot be empty.');
  const part: ImagePart = { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` } };
  validateImage(part);
  return part;
}

export function validateImage(part: ImagePart): void {
  const url = part.image_url?.url;
  const match = typeof url === 'string' && /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || !match[2] || match[2].length % 4 !== 0) {
    throw new CerebrasValidationError('Images require canonical PNG/JPEG base64 data URIs; remote URLs are unsupported.');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) throw new CerebrasValidationError('Invalid image base64 encoding.');
  const validMagic = match[1] === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!validMagic) throw new CerebrasValidationError('Image bytes do not match their PNG/JPEG MIME type.');
  // No image decoder dependency: final integrity, pixel/dimension/decompression limits are checked by Cerebras.
}
