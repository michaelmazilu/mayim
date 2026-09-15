/**
 * Server-only HTTP helpers shared by the external data providers.
 * No API keys are involved anywhere in this module.
 */

/** Fixed backoff between the first attempt and the single retry. */
const RETRY_BACKOFF_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * fetch() with a wall-clock ceiling on the RESPONSE, not on body streaming: the
 * timer is cleared once headers arrive. That is deliberate — Overpass answers
 * with headers quickly and then streams tens of megabytes, so bounding the whole
 * download would kill healthy requests while leaving slow server queues unbounded.
 * Rejects with an AbortError once the timeout fires; callers that must not throw
 * should go through `fetchJson`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Retries once on network error or 429/5xx, with a fixed backoff. Never throws past the caller's catch. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BACKOFF_MS);
    }
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      if (res.ok) {
        const data: unknown = await res.json();
        return data as T;
      }
      // Any 4xx other than 429 is a permanent client error: a retry cannot fix it.
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      // Network failure, malformed JSON, or timeout abort — fall through to the retry.
    }
  }
  return null;
}
