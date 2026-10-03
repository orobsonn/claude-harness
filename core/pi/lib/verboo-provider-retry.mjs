/**
 * Keep a Verboo inference alive through short outages using Pi's existing,
 * abortable HTTP retry. Finite budget; no process/session/tool restart and no
 * retry of a response whose stream has already started. Explicit limits win.
 * Without Retry-After, the native capped backoff waits roughly three minutes
 * per exhausted inference; Pi's existing conversation retry is still separate.
 */
export function registerVerbooProviderRetry(pi, streamSimple) {
  pi.registerProvider("verboo", {
    api: "openai-completions",
    streamSimple(model, context, options = {}) {
      return streamSimple(model, context, {
        ...options,
        maxRetries: options.maxRetries ?? 30,
        maxRetryDelayMs: options.maxRetryDelayMs ?? 60000,
      });
    },
  });
}
