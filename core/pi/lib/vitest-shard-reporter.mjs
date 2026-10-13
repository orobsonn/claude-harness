/** Send a terminal Vitest failure to the runner before remaining files/hooks run. */
export default class ShardFailureReporter {
  failed = false;
  onInit(context) { this.context = context; }

  onTaskUpdate(packs) {
    for (const [id, result] of packs) {
      if (result?.state !== "fail") continue;
      const task = this.context?.state?.idMap?.get(id);
      // Vitest emits updates during retries/repeats too. A completed test has
      // duration only after retry and it.fails handling; suite hook errors can
      // be reported immediately without waiting for poisoned sibling files.
      if (task?.type === "test" && result.duration === undefined) continue;
      this.notifyFailure(result.errors ?? [], task);
      break;
    }
  }

  onFinished(_files, errors) {
    if (errors?.length) this.notifyFailure(errors);
  }

  notifyFailure(errors, task) {
    if (this.failed) return;
    this.failed = true;
    const file = task?.file ?? (task?.filepath ? task : undefined);
    const names = [];
    const visited = new Set();
    for (let current = task; current && current !== file && !visited.has(current); current = current.suite) {
      visited.add(current);
      if (current.name) names.unshift(current.name);
    }
    const identity = [file?.filepath ?? file?.name, ...names].filter(Boolean).join(" > ");
    if (identity) this.context?.logger?.error?.(`[harness-tests] Failed task: ${identity}`);
    for (const error of errors) {
      // Preserve Vitest's original diagnostic before cancellation can prevent
      // the default reporter from printing its end-of-run failure summary.
      this.context?.logger?.printError(error, { fullStack: true });
    }
    if (process.connected) process.send({ type: "harness-vitest-failure", identity });
  }
}
