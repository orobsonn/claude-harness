import * as nodeModule from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { piChildResourceSettings, verifyPiChildBoundResources } from "../lib/pi-child-extensions.mjs";
import { createPiReviewConcurrency, isPiSubagentDescendant } from "../lib/pi-review-concurrency.mjs";
import { readPiReviewConfig } from "../lib/pi-review-config.mjs";
import { ensurePiRuntime, resolveVerifiedPiRuntime } from "../lib/pi-runtime-cache.mjs";
import { isRuntimeRole } from "../lib/roles.mjs";
import { parseReviewReportText, validateReviewReport } from "../vendor/shared/lib/review-report-schema.mjs";

type BridgeDeps = {
  root?: string;
  maxParallelEyes?: number;
  getAgentDir?: () => string;
  loadNativeFactory?: () => Promise<(pi: ExtensionAPI) => unknown>;
};

function resolveHarnessRoot(piRoot: string) {
  return basename(piRoot) === "pi" && basename(dirname(piRoot)) === "core"
    ? resolve(piRoot, "../..")
    : piRoot;
}

function harnessRoot() {
  return resolveHarnessRoot(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

const STRICT_REVIEW_ROLES = new Set([
  "harness-plan-reviewer",
  "harness-adversary",
  "harness-compliance",
  "harness-security",
]);

function compactLine(value: unknown, limit = 220) {
  const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function publicResultText(result: any) {
  return result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
}

function plannerSummary(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const authoredSummary = lines.at(-1);
  if (authoredSummary && /\b\d+\s+(?:tarefas?|tasks?)\b/i.test(authoredSummary)) {
    return `PLANO · ${compactLine(authoredSummary)}`;
  }

  const parsed = parseReviewReportText(text);
  if (Array.isArray(parsed?.tasks)) {
    const count = parsed.tasks.length;
    return `PLANO PRODUZIDO · ${count} ${count === 1 ? "tarefa" : "tarefas"}`;
  }
  return "PLANEJAMENTO · ver resultado expandido";
}

function publicOutcomeBody(text: string) {
  let body = text.trim();
  const envelope = body.match(/(?:^|\n)Agent completed in [^\n]*\r?\nAgent ID: [^\r\n]+\r?\n\r?\n/);
  if (envelope?.index !== undefined) body = body.slice(envelope.index + envelope[0].length).trim();
  return body;
}

function exactPublicReviewReport(text: string) {
  let body = publicOutcomeBody(text);
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) body = fenced[1].trim();
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictReviewSummary(role: string, text: string) {
  const logicalRole = role === "harness-plan-reviewer"
    ? "plan-reviewer"
    : role.replace(/^harness-/, "");
  const validated = validateReviewReport(logicalRole, exactPublicReviewReport(text));
  if (!validated.ok) return "PARECER: INDISPONÍVEL · expanda para ver a saída";

  if (logicalRole === "plan-reviewer") {
    if (validated.report.verdict === "APPROVE") {
      return validated.findings.length === 0
        ? "PARECER: APROVADO · sem achados"
        : "PARECER: INDISPONÍVEL · aprovação contradiz os achados reportados";
    }
    return `PARECER: REVISAR · ${compactLine(validated.findings[0]?.problem)}`;
  }
  if (validated.findings.length === 0) return "PARECER: APROVADO · sem achados";
  return `PARECER: REVISAR · ${compactLine(validated.findings[0]?.description)}`;
}

function testReviewReason(lines: string[], verdictIndex: number) {
  const beforeVerdict = lines.slice(0, verdictIndex);
  const findingsHeading = beforeVerdict.findIndex((line) => /^#{0,3}\s*(?:material\s+)?findings?\s*:?\s*$/i.test(line));
  if (findingsHeading !== -1) {
    const finding = beforeVerdict.slice(findingsHeading + 1).find((line) =>
      !/^[-*]?\s*(?:none|nenhum|sem achados)\.?$/i.test(line) && !/^\s*$/.test(line),
    );
    if (finding) return compactLine(finding.replace(/^[-*]\s*/, ""));
  }
  const failedRow = beforeVerdict.find((line) => /\b(?:FAIL|BLOCKED)\b/i.test(line));
  return failedRow ? compactLine(failedRow.replace(/^[-*]\s*/, "")) : "ver parecer expandido";
}

function testReviewerSummary(text: string) {
  const lines = publicOutcomeBody(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const verdicts = lines.flatMap((line, index) => {
    const match = line.match(/^Verdict:\s*(APPROVE|REVISE|BLOCKED)\s*$/i);
    return match ? [{ verdict: match[1].toUpperCase(), index }] : [];
  });
  if (verdicts.length !== 1 || verdicts[0].index !== lines.length - 1) {
    return "PARECER: INDISPONÍVEL · expanda para ver a saída";
  }
  const { verdict, index } = verdicts[0];
  if (verdict === "APPROVE") return "PARECER: APROVADO · obrigações de teste atendidas";
  const label = verdict === "REVISE" ? "REVISAR" : "BLOQUEADO";
  return `PARECER: ${label} · ${testReviewReason(lines, index)}`;
}

function firstUsefulResultLine(text: string) {
  const lines = publicOutcomeBody(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) =>
    !/^(?:Status|Verdict):/i.test(line) &&
    !/^```/.test(line) &&
    !/^\[HARNESS_[A-Z_]+(?:_RESULT)?\]/.test(line) &&
    !/^[\[\]{}]$/.test(line),
  );
  return useful ? compactLine(useful.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "")) : "ver resultado expandido";
}

function statusResultSummary(text: string) {
  const body = publicOutcomeBody(text);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const statuses = lines.flatMap((line, index) => {
    const match = line.match(/^Status:\s*(DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED)\s*$/i);
    return match ? [{ status: match[1].toUpperCase(), index }] : [];
  });
  const useful = firstUsefulResultLine(body);
  if (statuses.length !== 1 || statuses[0].index !== lines.length - 1) return `RESULTADO · ${useful}`;
  return `STATUS: ${statuses[0].status} · ${useful}`;
}

function harvesterSummary(text: string) {
  const body = publicOutcomeBody(text);
  const matches = [...body.matchAll(/\[HARNESS_HARVEST_RESULT\]([\s\S]*?)\[\/HARNESS_HARVEST_RESULT\]/g)];
  if (matches.length === 1) {
    try {
      const report = JSON.parse(matches[0][1]);
      if (Array.isArray(report?.changes) && report.changes.length <= 3) {
        const count = report.changes.length;
        return `HARVEST · ${count} ${count === 1 ? "delta proposto" : "deltas propostos"}`;
      }
    } catch { /* Fall through to the public neutral summary. */ }
  }
  return `HARVEST · ${firstUsefulResultLine(body)}`;
}

function summarizeHarnessSubagentResult(result: any) {
  const role = result?.details?.subagentType;
  if (result?.details?.status !== "completed" || !isRuntimeRole(role)) return null;
  const text = publicResultText(result);
  if (role === "harness-planner") return plannerSummary(text);
  if (role === "harness-test-reviewer") return testReviewerSummary(text);
  if (STRICT_REVIEW_ROLES.has(role)) return strictReviewSummary(role, text);
  if (role === "harness-harvester") return harvesterSummary(text);
  if (["harness-executor", "harness-test-author", "harness-sniper", "harness-shipper"].includes(role)) {
    return statusResultSummary(text);
  }
  return `RESULTADO · ${firstUsefulResultLine(text)}`;
}

function decorateNativeFactory(nativeFactory: (pi: ExtensionAPI) => unknown) {
  return (pi: ExtensionAPI) => nativeFactory(new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: any) => {
        if (tool?.name !== "subagent" || typeof tool.renderResult !== "function") {
          return Reflect.apply(target.registerTool, target, [tool]);
        }
        const nativeRenderResult = tool.renderResult;
        return Reflect.apply(target.registerTool, target, [{
          ...tool,
          renderResult(result: any, options: any, theme: any) {
            if (options?.expanded || options?.isPartial) {
              return Reflect.apply(nativeRenderResult, tool, [result, options, theme]);
            }
            const summary = summarizeHarnessSubagentResult(result);
            if (!summary) return Reflect.apply(nativeRenderResult, tool, [result, options, theme]);
            const displayResult = {
              ...result,
              content: [{ type: "text", text: `└ Done\n└ ${summary}` }],
            };
            return Reflect.apply(nativeRenderResult, tool, [
              displayResult,
              { ...options, expanded: true },
              theme,
            ]);
          },
        }]);
      };
    },
  }));
}

async function loadVerifiedNativeFactory() {
  let runtime = resolveVerifiedPiRuntime();
  if (!runtime.ok) runtime = ensurePiRuntime();
  if (!runtime.ok) {
    throw new Error(`[harness-subagents] ${runtime.reason}. Run harness init/update with target pi or all on this host to prepare the runtime.`);
  }
  const requireFromRuntime = nodeModule.createRequire(runtime.paths.piPackage);
  const { createJiti } = requireFromRuntime("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: true, tsconfigPaths: true });
  return jiti.import(runtime.paths.subagentsExtension, { default: true });
}

/** Harness-owned production composition root for the pinned native extension. */
export default async function harnessSubagents(pi: ExtensionAPI, deps: BridgeDeps = {}) {
  // Child resource loaders can encounter this entrypoint through package
  // autoload. The parent native factory is already alive in this async chain.
  if (isPiSubagentDescendant()) return;

  const root = deps.root ?? harnessRoot();
  const agentDir = (deps.getAgentDir ?? getAgentDir)();
  let configuredMaxParallelEyes = 3;
  try { configuredMaxParallelEyes = readPiReviewConfig(agentDir).maxParallelEyes; }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const maxParallelEyes = deps.maxParallelEyes ?? configuredMaxParallelEyes;
  const nativeFactory = await (deps.loadNativeFactory ?? loadVerifiedNativeFactory)();
  const bridge = createPiReviewConcurrency({
    maxParallelEyes,
    verifyChildBound: (payload: unknown) => verifyPiChildBoundResources(root, payload),
  });
  const result = bridge.wrapNativeFactory(decorateNativeFactory(nativeFactory))(pi);

  pi.on("session_start", (_event: unknown, ctx: any) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") return;
    ctx.ui.notify(`Harness parallel reviewers: ${maxParallelEyes}`, "info");
  });
  return result;
}

export const testApi = Object.freeze({
  harnessRoot,
  resolveHarnessRoot,
  loadVerifiedNativeFactory,
  piChildResourceSettings,
  summarizeHarnessSubagentResult,
  decorateNativeFactory,
  exactPublicReviewReport,
});
