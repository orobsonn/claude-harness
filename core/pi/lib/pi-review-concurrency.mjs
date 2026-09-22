import { AsyncLocalStorage } from "node:async_hooks";
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import { isParallelReviewRole, isRuntimeRole, isSupportRole } from "./roles.mjs";

const CHILD_SESSION_CREATED = "subagents:child:session-created";
const CHILD_BOUND = "subagents:child:bound";
const CHILD_BIND = "harness:child-bind";
const SUBAGENTS_SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");
const PARENT_READ_TOOLS = new Set(["read", "grep", "find", "ls", "get_result", "get_subagent_result", "harness_reviews"]);
const callIdentity = new AsyncLocalStorage();

/** True only inside the async chain of a native subagent tool execution. */
export function isPiSubagentDescendant() {
  return callIdentity.getStore() !== undefined;
}

/** Shared dispatch classification: fidelity/spec and other phases stay exclusive. */
export function classifyPiReviewDispatch(role, prompt) {
  if (!isParallelReviewRole(role) || typeof prompt !== "string") return null;
  if (prompt.startsWith("[HARNESS_FINAL_REVIEW]")) return { phase: "final" };
  if (!prompt.startsWith(role === "harness-adversary" ? "[HARNESS_TASK_CONTEXT]" : "[HARNESS_TASK_REVIEW]")) return null;
  const task = parseTaskDispatchIdentity(prompt);
  return task.ok ? { phase: "task", taskId: task.taskId } : null;
}

/** Repair only the two role-specific task-review header inversions accepted by the dispatch rail. */
export function canonicalTaskReviewPrompt(role, prompt, taskId) {
  if (typeof prompt !== "string" || typeof taskId !== "string" || taskId.length === 0) return prompt;
  const marker = `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`;
  const review = "[HARNESS_TASK_REVIEW]";
  if (role === "harness-adversary") {
    for (const separator of ["\n", "\r\n"]) {
      const inverted = `${review}${separator}${marker}`;
      if (prompt.startsWith(inverted)) return prompt.slice(review.length + separator.length);
    }
  } else if ((role === "harness-compliance" || role === "harness-security") && prompt.startsWith(marker)) {
    return `${review}\n${prompt}`;
  }
  return prompt;
}

function abortError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "AbortError";
  return error;
}

function signalReason(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason;
  return abortError(fallback, signal?.reason);
}

function configuredLimit(value) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new RangeError("maxParallelEyes must be an integer from 1 to 3");
  }
  return value;
}

export function createPiReviewConcurrency(options = {}) {
  const maxParallelEyes = configuredLimit(options.maxParallelEyes);
  const bindChildSession = options.bindChildSession;
  const verifyChildBound = options.verifyChildBound;
  const resolveTaskReviewId = options.resolveTaskReviewId;
  if (bindChildSession !== undefined && typeof bindChildSession !== "function") {
    throw new TypeError("bindChildSession must be a function");
  }
  if (verifyChildBound !== undefined && typeof verifyChildBound !== "function") {
    throw new TypeError("verifyChildBound must be a function");
  }
  if (resolveTaskReviewId !== undefined && typeof resolveTaskReviewId !== "function") {
    throw new TypeError("resolveTaskReviewId must be a function");
  }

  return {
    wrapNativeFactory(nativeFactory) {
      if (typeof nativeFactory !== "function") throw new TypeError("nativeFactory must be a function");

      return function reviewConcurrencyExtension(pi) {
        const queue = [];
        const activeControllers = new Set();
        const activeExecutes = new Set();
        const activeToolCallIds = new Set();
        const preparedLeases = new Map();
        let activeCount = 0;
        let exclusiveActive = false;
        let admissionClosed = false;

        function removeAbortListener(job) {
          if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
        }

        function cancelQueued(job, reason) {
          if (job.state !== "queued") return;
          job.state = "cancelled";
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          removeAbortListener(job);
          job.reject(reason);
          drain();
        }

        function start(job) {
          job.state = "active";
          activeCount += 1;
          exclusiveActive = job.exclusive;
          activeToolCallIds.add(job.identity.toolCallId);

          const controller = new AbortController();
          job.controller = controller;
          activeControllers.add(controller);
          if (job.signal?.aborted) controller.abort(signalReason(job.signal, "subagent dispatch aborted"));

          let nativeResult;
          try {
            nativeResult = callIdentity.run(job.identity, () => job.execute(controller.signal));
          } catch (error) {
            nativeResult = Promise.reject(error);
          }
          const nativeSettlement = Promise.resolve(nativeResult);
          activeExecutes.add(nativeSettlement);

          void nativeSettlement.then(
            (result) => {
              if (controller.signal.aborted) {
                job.reject(signalReason(controller.signal, "subagent dispatch aborted"));
                return;
              }
              job.resolve(result);
            },
            (error) => job.reject(error),
          ).finally(() => {
            job.state = "settled";
            removeAbortListener(job);
            activeControllers.delete(controller);
            activeExecutes.delete(nativeSettlement);
            activeToolCallIds.delete(job.identity.toolCallId);
            activeCount -= 1;
            if (job.exclusive) exclusiveActive = false;
            drain();
          });
        }

        function drain() {
          if (admissionClosed || exclusiveActive || queue.length === 0) return;

          if (queue[0].exclusive) {
            if (activeCount === 0) start(queue.shift());
            return;
          }

          while (queue.length > 0 && !queue[0].exclusive && activeCount < maxParallelEyes) {
            start(queue.shift());
          }
        }

        function schedule(identity, signal, execute) {
          if (admissionClosed) {
            return Promise.reject(abortError("subagent dispatch cancelled during session shutdown"));
          }
          if (signal?.aborted) {
            return Promise.reject(signalReason(signal, "subagent dispatch aborted before admission"));
          }

          return new Promise((resolve, reject) => {
            const job = {
              controller: undefined,
              execute,
              exclusive: !identity.reviewPhase && !isSupportRole(identity.subagentType),
              identity,
              onAbort: undefined,
              reject,
              resolve,
              signal,
              state: "queued",
            };
            if (signal) {
              job.onAbort = () => {
                const reason = signalReason(signal, "subagent dispatch aborted");
                if (job.state === "queued") cancelQueued(job, reason);
                else if (job.state === "active") job.controller.abort(reason);
              };
              signal.addEventListener("abort", job.onAbort, { once: true });
            }
            queue.push(job);
            drain();
          });
        }

        function leaseKind(event, ctx) {
          if (PARENT_READ_TOOLS.has(event?.toolName)) return null;
          if (event?.toolName === "harness_tasks" && ["status", "wait"].includes(event?.input?.action)) return null;
          if (event?.toolName === "subagent") {
            if (isSupportRole(event?.input?.subagent_type)) return "reader";
            const role = event?.input?.subagent_type;
            const taskId = resolveTaskReviewId?.(event, ctx);
            const prompt = canonicalTaskReviewPrompt(role, event?.input?.prompt, taskId);
            const review = classifyPiReviewDispatch(role, prompt);
            if (review) return "reader";
          }
          return "exclusive";
        }

        function acquirePreparedLease(event, ctx) {
          const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
          if (!callId || preparedLeases.has(callId)) return;
          const kind = leaseKind(event, ctx);
          if (!kind) return;
          const leases = [...preparedLeases.values()];
          const conflicts = kind === "exclusive"
            ? leases.length > 0
            : leases.includes("exclusive");
          if (conflicts) {
            const requested = kind === "exclusive" ? "a mutation/serial" : "a review/reader";
            const active = leases.includes("exclusive") ? "an active mutation/serial" : "active review/reader";
            return {
              block: true,
              reason: `[review-concurrency] Blocked: ${event?.toolName ?? "tool"} requests ${requested} lease while ${active} lease exists; retry after the active lease ends. Shell tools are treated as mutation-capable even when the command appears read-only.`,
            };
          }
          preparedLeases.set(callId, kind);
        }

        const wrappedEvents = new Proxy(pi.events, {
          get(target, property, receiver) {
            if (property !== "emit") return Reflect.get(target, property, receiver);
            return (event, payload) => {
              if (event === CHILD_BOUND && verifyChildBound && callIdentity.getStore()) {
                const verified = verifyChildBound(payload);
                if (verified && typeof verified.then === "function") {
                  void Promise.resolve(verified).catch(() => {});
                  throw new Error("child bound verification must be synchronous");
                }
                if (verified?.ok !== true) {
                  const reason = typeof verified?.reason === "string" ? `: ${verified.reason}` : "";
                  throw new Error(`child bound resources were not acknowledged${reason}`);
                }
              }
              if (event === CHILD_SESSION_CREATED && bindChildSession) {
                const identity = callIdentity.getStore();
                if (identity) {
                  const request = {
                    toolCallId: identity.toolCallId,
                    subagentType: identity.subagentType,
                    parentSessionId: payload?.parentSessionId,
                    childSessionId: payload?.sessionId,
                  };
                  const bound = bindChildSession(request);
                  // Binding occurs before the native event bus and must finish synchronously.
                  // A thenable cannot protect child extension startup; consume rejection too.
                  if (bound && typeof bound.then === "function") {
                    void Promise.resolve(bound).catch(() => {});
                    throw new Error("child session binding must be synchronous");
                  }
                  if (bound?.ok !== true) throw new Error("child session binding was not acknowledged");
                }
              } else if (event === CHILD_SESSION_CREATED) {
                const identity = callIdentity.getStore();
                if (identity) {
                  const request = {
                    toolCallId: identity.toolCallId,
                    subagentType: identity.subagentType,
                    parentSessionId: payload?.parentSessionId,
                    childSessionId: payload?.sessionId,
                  };
                  Reflect.apply(target.emit, target, [CHILD_BIND, request]);
                  if (request.result?.ok !== true) {
                    const reason = typeof request.result?.reason === "string" ? `: ${request.result.reason}` : "";
                    throw new Error(`child session binding was not acknowledged${reason}`);
                  }
                }
              }
              return Reflect.apply(target.emit, target, [event, payload]);
            };
          },
        });

        const wrappedPi = new Proxy(pi, {
          get(target, property, receiver) {
            if (property === "events") return wrappedEvents;
            if (property !== "registerTool") return Reflect.get(target, property, receiver);
            return (tool) => {
              if (tool?.name !== "subagent" || typeof tool.execute !== "function") {
                return Reflect.apply(target.registerTool, target, [tool]);
              }
              const nativeExecute = tool.execute;
              return Reflect.apply(target.registerTool, target, [{
                ...tool,
                execute(toolCallId, params, signal, ...rest) {
                  const subagentType = params?.subagent_type;
                  return schedule(
                    { toolCallId, subagentType, reviewPhase: classifyPiReviewDispatch(subagentType, params?.prompt) },
                    signal,
                    (scheduledSignal) => Reflect.apply(nativeExecute, tool, [
                      toolCallId,
                      params,
                      scheduledSignal,
                      ...rest,
                    ]),
                  );
                },
              }]);
            };
          },
        });

        const result = nativeFactory(wrappedPi);
        const service = globalThis[SUBAGENTS_SERVICE_KEY];
        if (service && typeof service === "object" && typeof service.spawn === "function") {
          const nativeSpawn = service.spawn;
          service.spawn = function guardedHarnessSpawn(type, ...args) {
            if (isRuntimeRole(type)) {
              throw new Error(`harness runtime role ${type} must dispatch through the guarded subagent tool`);
            }
            return Reflect.apply(nativeSpawn, this, [type, ...args]);
          };
        }
        pi.on("tool_call", (event, ctx) => acquirePreparedLease(event, ctx));
        pi.on("tool_execution_end", (event) => {
          if (typeof event?.toolCallId === "string") preparedLeases.delete(event.toolCallId);
        });
        pi.on("turn_end", () => {
          for (const callId of preparedLeases.keys()) {
            if (!activeToolCallIds.has(callId)) preparedLeases.delete(callId);
          }
        });
        pi.on("session_shutdown", async () => {
          admissionClosed = true;
          const shutdownReason = abortError("subagent dispatch cancelled during session shutdown");
          for (const job of queue.splice(0)) {
            job.state = "cancelled";
            removeAbortListener(job);
            job.reject(shutdownReason);
          }
          for (const controller of activeControllers) controller.abort(shutdownReason);
          await Promise.allSettled([...activeExecutes]);
        });
        return result;
      };
    },
  };
}
