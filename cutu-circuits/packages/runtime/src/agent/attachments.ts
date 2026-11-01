import { imageFromBytes, type ImagePart } from "@cutucircuits/cerebras";

export interface AgentAttachment {
  name: string;
  dataUrl: string;
}
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Decode only caller-supplied image bytes. Never read disk or fetch a URL. */
export function validateAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2)
    throw new Error(
      "INVALID_ATTACHMENTS: at most two PNG/JPEG images are supported",
    );
  let total = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 128 ||
      /[\x00-\x1f\/\\]/.test(item.name) ||
      typeof item.dataUrl !== "string" ||
      item.dataUrl.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3) + 32
    )
      throw new Error("INVALID_ATTACHMENTS");
    const match =
      /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        item.dataUrl,
      );
    if (!match || match[2].length % 4)
      throw new Error(
        "INVALID_ATTACHMENTS: canonical PNG/JPEG data URLs required",
      );
    const bytes = Buffer.from(match[2], "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== match[2] || total > MAX_ATTACHMENT_BYTES)
      throw new Error(
        "INVALID_ATTACHMENTS: total image size exceeds 3 MiB or invalid encoding",
      );
    imageFromBytes(bytes, match[1] as "image/png" | "image/jpeg");
    return { name: item.name, dataUrl: item.dataUrl };
  });
}
export const attachmentParts = (attachments: AgentAttachment[]): ImagePart[] =>
  attachments.map((attachment) => ({
    type: "image_url",
    image_url: { url: attachment.dataUrl },
  }));
