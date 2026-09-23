import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ControlPlane } from "../lib/control-plane.mjs";

function output(value: any, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

export async function runSilentSupervisorTick(pi: ExtensionAPI, control: ControlPlane, ctx: any) {
  if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) return { ok: true, outcome: "busy" };
  const notification = await control.nextNotification();
  if (!notification) return { ok: true, outcome: "quiet" };
  await pi.sendMessage({
    customType: "harness-control-notification",
    display: true,
    content: JSON.stringify({
      source: "harness-control-plane-host",
      grants_operator_authority: false,
      notification,
      instruction: "Mudança material observada. Consulte harness_control action=portfolio uma única vez para esta entrega. Se type=session.attention-needed, não faça polling nem repita leituras: o supervisor já descartou filhos ativos do Harness; faça no máximo uma leitura limitada do terminal exato e, se ela não bastar, classifique como ociosidade desconhecida. Informe projeto, issue, fato, consequência, opções e recomendação curta. Não execute ação reservada sem uma mensagem explícita do operador no turno atual.",
    }),
  }, { triggerTurn: true });
  await control.acknowledgeNotification(notification);
  return { ok: true, outcome: "notified", notification };
}

export async function executeControlAction(control: ControlPlane, input: any) {
  switch (input.action) {
    case "discover_projects":
      return control.discoverProjects(input.project_query);
    case "register_project":
      return control.registerProject(input.project);
    case "resolve_project":
      return control.resolveProject(input.project_query);
    case "consumer_status": {
      const resolved = control.resolveProject(input.project_query);
      if (!resolved.ok) return resolved;
      return control.consumerCapabilities(resolved.project);
    }
    case "discover_runs":
      return control.discoverRuns(input.project_query);
    case "track_run":
      return control.trackRun(input.project_query, input.candidate_id);
    case "send_tracked_run_message":
      return control.sendTrackedRunMessage({
        delivery_id: input.delivery_id,
        message: input.message,
        authorization: input.authorization,
      });
    case "recommend_issue":
      return control.recommendIssue(input.project_query);
    case "start_delivery":
      return control.startDelivery(input.recommendation_id, input.authorization);
    case "resume_delivery":
      return control.resumeDelivery({ delivery_id: input.delivery_id, instruction: input.instruction, authorization: input.authorization });
    case "portfolio":
      return control.verifiedPortfolio(input.project_query);
    case "answer_decision":
      return control.answerDecision({
        delivery_id: input.delivery_id,
        decision_id: input.decision_id,
        revision: input.revision,
        answer: input.answer,
        authorization: input.authorization,
      });
    case "automation_status":
      return control.automationStatus(input.project_query);
    case "automation_enable":
      return control.enableAutomation(input.project_query, input.authorization);
    case "wait":
      return control.waitForChange({ delivery_id: input.delivery_id, after_sequence: input.after_sequence, timeout_ms: input.timeout_ms });
    case "set_enabled":
      if (input.authorization !== "explicit-current-turn") throw new Error("set_enabled requires explicit current-turn operator authorization");
      return { ok: true, settings: await control.setEnabled(input.enabled) };
    default:
      throw new Error(`unsupported control action: ${input.action}`);
  }
}

export default function controlPlaneTools(pi: ExtensionAPI, injected: any = {}) {
  const control = injected.control ?? new ControlPlane();
  const intervalMs = injected.intervalMs ?? 2_000;
  const setIntervalFn = injected.setIntervalFn ?? setInterval;
  const clearIntervalFn = injected.clearIntervalFn ?? clearInterval;
  let supervisorTimer: any;
  let supervisorBusy = false;
  const stopSupervisor = () => {
    if (supervisorTimer) clearIntervalFn(supervisorTimer);
    supervisorTimer = undefined;
  };
  const startSupervisor = (_event: any, ctx: any) => {
    stopSupervisor();
    const tick = async () => {
      if (supervisorBusy) return;
      supervisorBusy = true;
      try { await runSilentSupervisorTick(pi, control, ctx); }
      catch { /* Durable cursors remain unchanged; the next tick retries. */ }
      finally { supervisorBusy = false; }
    };
    void tick();
    supervisorTimer = setIntervalFn(tick, intervalMs);
    supervisorTimer?.unref?.();
  };
  pi.on("session_start", startSupervisor);
  pi.on("session_shutdown", stopSupervisor);
  pi.on("tool_result", (event: any) => {
    if (event.toolName === "harness_control" && event.details?.ok === false) return { isError: true };
  });
  pi.registerTool({
    name: "harness_control",
    label: "Harness control plane",
    description: "The structured Claude Harness interface for the general agent. Discover projects and already-running parents from Orca and Harness-owned evidence, track a preexisting run read-only without restarting it, resolve/register projects, check consumer compatibility, recommend without starting, start exactly a stored recommendation with current-turn operator authorization, inspect the portfolio, forward an explicitly authorized answer, wait on host events, or inspect/enable an already-existing automation with current-turn authorization. It cannot create a scheduler, dispatch internal workers, merge, deploy, or clean up.",
    parameters: Type.Object({
      action: Type.Union([
        "discover_projects", "register_project", "resolve_project", "consumer_status", "discover_runs", "track_run", "send_tracked_run_message", "recommend_issue", "start_delivery", "resume_delivery",
        "portfolio", "answer_decision", "automation_status", "automation_enable", "wait", "set_enabled",
      ].map((value) => Type.Literal(value))),
      project_query: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      project: Type.Optional(Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 20 })),
        repo_path: Type.String({ minLength: 1, maxLength: 4096 }),
        gh_repo: Type.Optional(Type.String({ minLength: 3, maxLength: 256 })),
        orca_repo_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        base_branch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        setup: Type.Optional(Type.Union(["run", "skip", "inherit"].map((value) => Type.Literal(value)))),
        automation: Type.Optional(Type.Union([
          Type.Object({ kind: Type.Literal("crontab-selector"), config_path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
          Type.Object({ kind: Type.Literal("orca"), id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
        ])),
      }, { additionalProperties: false })),
      recommendation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      candidate_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      delivery_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      decision_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      answer: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      authorization: Type.Optional(Type.Literal("explicit-current-turn")),
      after_sequence: Type.Optional(Type.Integer({ minimum: 0 })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })),
      enabled: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, input: any) {
      try {
        const value = await executeControlAction(control, input);
        return output(value, value?.ok === false);
      } catch (error) {
        return output({ ok: false, reason: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });
}
