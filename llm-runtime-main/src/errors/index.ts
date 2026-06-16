// NIB-M-ERRORS — full taxonomy (abstract base + 11 concrete subclasses).
// `kind` is a getter to enforce runtime read-only semantics (C-ER-04).

import type { LLMErrorKind } from '../services/error-kind.js';
import type { ProviderLongId } from '../types.js';

export interface LLMRuntimeErrorInit {
  readonly message?: string;
  readonly cause?: unknown;
  readonly callId?: string;
  readonly provider?: ProviderLongId;
  readonly model?: string;
  readonly attempts?: number;
}

export abstract class LLMRuntimeError extends Error {
  public abstract readonly kind: LLMErrorKind;
  public readonly callId?: string;
  public readonly provider?: ProviderLongId;
  public readonly model?: string;
  public readonly attempts?: number;

  constructor(init: LLMRuntimeErrorInit = {}) {
    super(
      init.message ?? 'LLMRuntimeError',
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = new.target.name;
    if (init.callId !== undefined) this.callId = init.callId;
    if (init.provider !== undefined) this.provider = init.provider;
    if (init.model !== undefined) this.model = init.model;
    if (init.attempts !== undefined) this.attempts = init.attempts;
  }
}

export class AuthError extends LLMRuntimeError {
  public override get kind(): 'auth' {
    return 'auth';
  }
}

export class InvalidRequestError extends LLMRuntimeError {
  public override get kind(): 'invalid_request' {
    return 'invalid_request';
  }
}

export interface RateLimitErrorInit extends LLMRuntimeErrorInit {
  readonly retryAfterMs?: number;
}

export class RateLimitError extends LLMRuntimeError {
  public readonly retryAfterMs?: number;

  constructor(init: RateLimitErrorInit = {}) {
    super(init);
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }

  public override get kind(): 'rate_limit' {
    return 'rate_limit';
  }
}

export interface OverloadedErrorInit extends LLMRuntimeErrorInit {
  readonly retryAfterMs?: number;
}

export class OverloadedError extends LLMRuntimeError {
  public readonly retryAfterMs?: number;

  constructor(init: OverloadedErrorInit = {}) {
    super(init);
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }

  public override get kind(): 'overloaded' {
    return 'overloaded';
  }
}

export type NetworkErrorKind = 'dns' | 'connection' | 'reset' | 'unknown';

export interface TransientProviderErrorInit extends LLMRuntimeErrorInit {
  readonly status?: number;
  readonly networkErrorKind?: NetworkErrorKind;
}

export class TransientProviderError extends LLMRuntimeError {
  public readonly status?: number;
  public readonly networkErrorKind?: NetworkErrorKind;

  constructor(init: TransientProviderErrorInit = {}) {
    super(init);
    if (init.status !== undefined) this.status = init.status;
    if (init.networkErrorKind !== undefined) this.networkErrorKind = init.networkErrorKind;
  }

  public override get kind(): 'transient_provider' {
    return 'transient_provider';
  }
}

export class ProviderProtocolError extends LLMRuntimeError {
  public override get kind(): 'provider_protocol' {
    return 'provider_protocol';
  }
}

export class ResponseParseError extends LLMRuntimeError {
  public override get kind(): 'response_parse' {
    return 'response_parse';
  }
}

export interface TimeoutErrorInit extends LLMRuntimeErrorInit {
  readonly timeoutMs?: number;
}

export class TimeoutError extends LLMRuntimeError {
  public readonly timeoutMs?: number;

  constructor(init: TimeoutErrorInit = {}) {
    super(init);
    if (init.timeoutMs !== undefined) this.timeoutMs = init.timeoutMs;
  }

  public override get kind(): 'timeout' {
    return 'timeout';
  }
}

export class AbortedError extends LLMRuntimeError {
  public override get kind(): 'aborted' {
    return 'aborted';
  }
}

export type SilentTruncationMode = 'heuristic_json_unclosed' | 'silent_prompt_truncation';

export interface SilentTruncationErrorInit extends LLMRuntimeErrorInit {
  readonly truncationMode?: SilentTruncationMode;
}

export class SilentTruncationError extends LLMRuntimeError {
  public readonly truncationMode?: SilentTruncationMode;

  constructor(init: SilentTruncationErrorInit = {}) {
    super(init);
    if (init.truncationMode !== undefined) this.truncationMode = init.truncationMode;
  }

  public override get kind(): 'silent_truncation' {
    return 'silent_truncation';
  }
}

export interface ContentFilterErrorInit extends LLMRuntimeErrorInit {
  readonly reason?: string;
}

export class ContentFilterError extends LLMRuntimeError {
  public readonly reason?: string;

  constructor(init: ContentFilterErrorInit = {}) {
    super(init);
    if (init.reason !== undefined) this.reason = init.reason;
  }

  public override get kind(): 'content_filter' {
    return 'content_filter';
  }
}
