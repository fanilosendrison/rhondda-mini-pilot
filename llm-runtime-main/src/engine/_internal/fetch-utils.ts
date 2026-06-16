// Shared fetch-with-abort wrapper for execute-call and execute-embedding.
// Races the actual fetch against an abort promise to cover mocks that
// do not honor the signal (NIB-T §27.6 mock-fetch).

/**
 * Normalize response headers to lowercase keys (I-13).
 * Shared by execute-call and execute-embedding.
 */
export function normalizeHeaders(responseHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  responseHeaders.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

export async function runFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  };
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([fetchImpl(url, init), abortPromise]);
}
