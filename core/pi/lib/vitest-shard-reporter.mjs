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
      this.notifyFailure(result.errors ?? []);
      break;
    }
  }

  onFinished(_files, errors) {
    if (errors?.length) this.notifyFailure(errors);
  }

  notifyFailure(errors) {
    if (this.failed) return;
    this.failed = true;
    for (const error of errors) {
      // Preserve Vitest's original diagnostic before cancellation can prevent
      // the default reporter from printing its end-of-run failure summary.
      this.context?.logger?.printError(error, { fullStack: true });
    }
    if (process.connected) process.send({ type: "harness-vitest-failure" });
  }
}
