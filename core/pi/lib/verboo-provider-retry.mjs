/** Use Pi's existing HTTP retry implementation only for the Verboo provider. */
export function registerVerbooProviderRetry(pi, streamSimple) {
  pi.registerProvider("verboo", {
    api: "openai-completions",
    streamSimple(model, context, options = {}) {
      return streamSimple(model, context, {
        ...options,
        maxRetries: options.maxRetries ?? 2,
        maxRetryDelayMs: options.maxRetryDelayMs ?? 60000,
      });
    },
  });
}
