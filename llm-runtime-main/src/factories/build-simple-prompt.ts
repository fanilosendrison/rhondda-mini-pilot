// NIB-M-FACTORIES §5.4 — ergonomic helper. No semantic decision.

import { InvalidRequestError } from '../errors/index.js';
import type { LLMMessage } from '../types.js';

export interface SimplePromptInput {
  readonly system?: string;
  readonly user: string;
}

export function buildSimplePrompt(input: SimplePromptInput): readonly LLMMessage[] {
  if (input.user === undefined || input.user.length === 0) {
    throw new InvalidRequestError({ message: 'buildSimplePrompt: user prompt is required' });
  }
  const messages: LLMMessage[] = [];
  if (input.system !== undefined && input.system.length > 0) {
    messages.push({ role: 'system', content: input.system });
  }
  messages.push({ role: 'user', content: input.user });
  return messages;
}
