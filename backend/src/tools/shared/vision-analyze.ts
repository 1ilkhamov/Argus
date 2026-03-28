import type { LlmService } from '../../llm/llm.service';
import type { LlmMessage, LlmContentPart } from '../../llm/interfaces/llm.interface';

/**
 * Analyze an image using the LLM vision API.
 *
 * Shared helper used by the vision tool (desktop screenshots, local images)
 * and the browser tool (page screenshots).
 *
 * @param llm       — LlmService instance
 * @param base64    — base64-encoded image data
 * @param mimeType  — image MIME type (e.g. 'image/png', 'image/jpeg')
 * @param question  — question or instruction about the image
 * @param maxTokens — max response tokens (default 1024)
 * @returns analysis text
 */
export async function analyzeImageWithVision(
  llm: LlmService,
  base64: string,
  mimeType: string,
  question: string,
  maxTokens = 1024,
): Promise<string> {
  const contentParts: LlmContentPart[] = [
    { type: 'text', text: question },
    {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` },
    },
  ];

  const messages: LlmMessage[] = [
    { role: 'user', content: contentParts },
  ];

  const result = await llm.complete(messages, { maxTokens });
  return result.content.trim() || 'No analysis produced.';
}
