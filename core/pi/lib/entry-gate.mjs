/**
 * @description Entry-gate da lane Pi — rails de bash e de dispatch de subagente.
 *
 * As decisões compartilhadas de bash e dispatch não são reimplementadas aqui:
 * bash-decide.mjs e entry-decide.mjs da lane OC são PUROS e host-agnósticos (o gate-state chega
 * como objeto), então são reusados INTEGRALMENTE por import. Este adaptador acrescenta apenas a
 * prova mecânica Pi de release-only: numa cópia efêmera do estado, retira obrigações de tasks com
 * SHA antigo comprovadamente fora da ancestry; nenhum marker persistido é alterado. O restante
 * orquestra a MESMA ordem do
 * core/opencode/plugin/entry-gate.ts com os caminhos da lane Pi (`.pi/harness/state/`) e com
 * os sinais do runtime do Pi (sessão filha por ctx.sessionManager.getHeader().parentSession,
 * em vez do session.parentID do SDK do OpenCode).
 *
 * Contrato de falha (idêntico ao da lane OC):
 * - bash: gate-state ilegível/ausente/sessionId inseguro → FAIL-OPEN (gate-state vira {}); os
 *   rails de branch/zero-commits, regate, captura e real-file ainda rodam contra {}. A ÚNICA
 *   exceção fail-closed deliberada é um regate_pending CORROMPIDO (presente e não-array);
 *   hand_finished/capture_verified/regate_passed coagem para [] silenciosamente.
 * - dispatch: gate-state ilegível → fail-OPEN apenas quando a reason começa com 'gate-state'
 *   (log em console.error); falha de IDENTIDADE (sessionId ausente/inseguro) é fail-CLOSED.
 * - `gh pr merge` é fail-CLOSED (evidência de CI ausente/pendente/vermelha nega), preservando a
 *   exceção do merge lifecycle-only sem CI; a release-only também exige que HEAD/base/branches do
 *   PR observado correspondam exatamente à prova local.
 * - denylist de frota só é consultada sob HARNESS_NOTIFY_PROJECT; módulo ausente = fail-open
 *   RUIDOSO (console.error), nunca silencioso.
 *
 * Toda mensagem de negação carrega o texto EXATO do Decision.reason da lane OC, prefixo
 * `[entry-gate]` incluído — o adaptador devolve {block:true, reason} sem reescrever nada.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { formatFeatureTaskEntry, matchesAbsolution } from "../../shared/lib/absolution.mjs";
import { checkFrozen, checkScope } from "../../shared/lib/capture-oracle.mjs";
import { mergeGateStatePatch } from "../../shared/lib/gate-state-shape.mjs";
import { computeGitState } from "../../shared/lib/git-state.mjs";
import {
  decideMergeChecks,
  isGhPrMergeCommand,
  mergeTargetFromCommand,
} from "../../shared/lib/merge-check-gate.mjs";
import {
  applyAdvisory,
  decideBashAdvisory,
  decideBashDelivery,
  decideBashHarnessLabel,
  detectHarnessLabelWrite,
  isDeliveryCommand,
  isRoutineSession,
} from "../../opencode/plugin/lib/bash-decide.mjs";
import { decideEntryTask, hasFidelityPass } from "../../opencode/lib/entry-decide.mjs";
import { resolveHookIdentity } from "../../opencode/plugin/lib/hook-identity.mjs";
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import {
  isCapacityExhaustedOutput,
  parseHandStatusFromOutput,
} from "../../opencode/lib/hand-records.mjs";
import { pathsChangedSinceBaseline } from "../../opencode/lib/worktree-baseline.mjs";
import { withGateStateLock } from "../../opencode/lib/gate-state.mjs";
import {
  isDeliveryRole,
  isExecutorRole,
  isSniperRole,
  isTestAuthorRole,
  toOcRole,
} from "./pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "./pi-gate-state.mjs";
import { piGateStatePath } from "./pi-paths.mjs";
import {
  piReleaseMergeMatchesProof,
  resolvePiReleaseProof,
  scopePiReleaseOnlyTaskState,
} from "./release-only.mjs";
import { readPiSpecApproval, readPiSpecDraft } from "./spec-approval.mjs";
import {
  claimPiDispatchForRuntime,
  listPiHandRecordsForFeature,
  readPiCanonicalTaskPolicy,
  readPiDispatchRecord,
  removePiDispatchRecord,
  writePiHandRecord,
} from "./pi-state-records.mjs";

const PREFIX = "[entry-gate]";

const ALLOW = Object.freeze({ ok: true, decision: "allow", reason: "pi-entry-allow" });

/**
 * @description O Pi materializa transcrições, locks e records do próprio runtime dentro da
 * worktree. Eles são efeitos do HOST, não alterações feitas pela mão na issue; atribuí-los à
 * mão transformaria toda conclusão em falsa violação de escopo. A exceção se limita a duas
 * subárvores host-owned; plano canônico e qualquer outro caminho continuam visíveis ao capture rail.
 * @param {unknown[]} paths
 * @returns {string[]}
 */
export function excludePiHarnessArtifacts(paths) {
  return (Array.isArray(paths) ? paths : []).filter(
    (item) =>
      typeof item === "string" &&
      !item.startsWith(".pi/harness/runtime/") &&
      !item.startsWith(".pi/harness/state/"),
  );
}

/** @description Papel que ESCREVE código/teste (executor/sniper/test-author), no vocabulário do
 * Pi ('harness-executor') ou no bare da lane OC. Nunca lança.
 * @param {unknown} role
 * @returns {boolean} */
export function isWritingHandRole(role) {
  const bare = toOcRole(role);
  return isExecutorRole(bare) || isSniperRole(bare) || isTestAuthorRole(bare);
}

/** @description Executa git e devolve stdout trimado; lança em erro (o chamador é quem decide
 * o fail-open). Espelha realGitRunner do entry-gate.ts.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} */
function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** @description Sonda git fail-open: devolve {branch,commitsAhead,defaultBranch} ou null em
 * qualquer erro. Só é chamada para comandos de delivery.
 * @param {string} projectRoot
 * @returns {{branch: string|null, commitsAhead: number|null, defaultBranch: string|null}|null} */
export function piGitState(projectRoot) {
  try {
    return computeGitState((args) => runGit(args, projectRoot));
  } catch {
    return null;
  }
}

/** @description `git merge-base --is-ancestor <sha> HEAD` → true / false / null (indeterminado).
 * @param {string} sha
 * @param {string} projectRoot
 * @returns {boolean|null} */
export function piIsAncestor(sha, projectRoot) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
    if (status === 1) return false;
    return null;
  }
}

/** @description Uma leitura direta do rollup de checks do PR exato. Evidência indisponível é
 * negada pela política compartilhada (decideMergeChecks), não aqui.
 * @param {string|null} target
 * @param {string} projectRoot
 * @returns {unknown} */
export function piMergeCheckRollup(target, projectRoot) {
  try {
    const output = execFileSync(
      "gh",
      ["pr", "view", ...(target === null ? [] : [target]), "--json", "statusCheckRollup"],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    return JSON.parse(output)?.statusCheckRollup;
  } catch {
    return null;
  }
}

/** @description Lê CI e identidade do mesmo PR numa única observação, evitando que a prova local
 * de release libere um target diferente. Null em qualquer falha; o chamador nega fail-closed.
 * @param {string|null} target
 * @param {string} projectRoot
 * @returns {unknown} */
export function piMergeCheckEvidence(target, projectRoot) {
  try {
    const output = execFileSync(
      "gh",
      [
        "pr",
        "view",
        ...(target === null ? [] : [target]),
        "--json",
        "statusCheckRollup,headRefOid,headRefName,baseRefName,baseRefOid",
      ],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function releaseProofForGate(input, projectRoot) {
  try {
    if (typeof input.resolveReleaseProofFn === "function") {
      return input.resolveReleaseProofFn(projectRoot);
    }
    if (typeof input.classifyReleaseOnlyFn === "function") {
      const injected = input.classifyReleaseOnlyFn(projectRoot);
      return injected?.ok ? { ...injected, phase: injected.phase ?? "pre-merge" } : injected;
    }
    return resolvePiReleaseProof(projectRoot, {
      readMergedReleaseEvidenceFn: input.readMergedReleaseEvidenceFn,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "release proof unavailable" };
  }
}

function releaseOnlyScope({ gateState, isAncestorFn, proof }) {
  try {
    if (!proof?.ok) return { active: false, gateState, proof: null };
    const scoped = scopePiReleaseOnlyTaskState(gateState, isAncestorFn);
    if (!scoped.ok || scoped.ignoredTasks.length === 0) {
      return { active: false, gateState, proof: null };
    }
    return { active: true, gateState: scoped.state, proof };
  } catch {
    return { active: false, gateState, proof: null };
  }
}

function deliveryMayUseReleaseScope(command, proof) {
  if (proof?.ok !== true || proof.phase !== "pre-merge" || typeof command !== "string") {
    return false;
  }
  const trimmed = command.trim();
  return trimmed === `git push origin ${proof.branch}` || isGhPrMergeCommand(trimmed);
}

function isGitTagMutation(command) {
  if (typeof command !== "string") return false;
  const match = /(?:^|[\s/])git\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+)\s+)*tag(?:\s|$)([\s\S]*)/.exec(
    command.trim(),
  );
  if (!match) return false;
  const args = match[1].trim();
  return args !== "" && !/^(?:-l|--list|--points-at|--contains)(?:\s|$)/.test(args);
}

function isGhReleaseCreate(command) {
  return typeof command === "string" && /\bgh\s+release\s+create\b/.test(command);
}

function isTagPushAttempt(command) {
  return (
    typeof command === "string" &&
    /\bgit\s+[\s\S]*\bpush\b[\s\S]*(?:--tags\b|refs\/tags\/|(?:^|\s)v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\s|$))/.test(command)
  );
}

function tagPointsAtHead(projectRoot, proof) {
  try {
    return runGit(["rev-parse", `refs/tags/${proof.tag}^{commit}`], projectRoot) === proof.headSha;
  } catch {
    return false;
  }
}

function exactPostMergeTagCommand(command, proof) {
  return proof?.ok === true && proof.phase === "post-merge" && command.trim() === `git tag ${proof.tag}`;
}

function exactPostMergeTagPush(command, proof, projectRoot) {
  return Boolean(
    proof?.ok === true &&
      proof.phase === "post-merge" &&
      command.trim() === `git push origin ${proof.tag}` &&
      tagPointsAtHead(projectRoot, proof),
  );
}

const MAX_RELEASE_NOTES_BYTES = 128 * 1024;

export function piReleaseNotesFileMatches(projectRoot, proof, notesFile, deps = {}) {
  if (typeof proof?.releaseNotes !== "string" || proof.releaseNotes.length === 0) return false;
  const expected = Buffer.from(proof.releaseNotes, "utf8");
  if (expected.length > MAX_RELEASE_NOTES_BYTES) return false;
  if (typeof notesFile !== "string") return false;
  const expectedName = `release-notes-${proof.version}.md`;
  if (basename(notesFile) !== expectedName) return false;
  const candidate = resolve(projectRoot, notesFile);
  const allowed = new Set([
    resolve(projectRoot, expectedName),
    resolve(tmpdir(), expectedName),
  ]);
  if (!allowed.has(candidate)) return false;
  const lstatFn = typeof deps.lstatFn === "function" ? deps.lstatFn : lstatSync;
  const openFn = typeof deps.openFn === "function" ? deps.openFn : openSync;
  const fstatFn = typeof deps.fstatFn === "function" ? deps.fstatFn : fstatSync;
  const readFn = typeof deps.readFn === "function" ? deps.readFn : readSync;
  const closeFn = typeof deps.closeFn === "function" ? deps.closeFn : closeSync;
  let fd = null;
  try {
    const stat = lstatFn(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.length) return false;
    fd = openFn(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatFn(fd);
    if (!opened.isFile() || opened.size !== expected.length) return false;
    const buffer = Buffer.alloc(expected.length + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readFn(fd, buffer, offset, buffer.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) break;
      offset += count;
    }
    return offset === expected.length && buffer.subarray(0, offset).equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeFn(fd);
      } catch {
        // A falha ao fechar não transforma conteúdo já rejeitado em prova válida.
      }
    }
  }
}

function exactPostMergeReleaseCreate(command, proof, projectRoot) {
  if (
    proof?.ok !== true ||
    proof.phase !== "post-merge" ||
    typeof command !== "string" ||
    /["'`$\\();|&]/.test(command) ||
    !tagPointsAtHead(projectRoot, proof)
  ) {
    return false;
  }
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 4 || tokens[0] !== "gh" || tokens[1] !== "release" || tokens[2] !== "create") {
    return false;
  }
  if (tokens[3] !== proof.tag) return false;
  const values = new Map();
  const booleans = new Set();
  for (let index = 4; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["--latest", "--verify-tag"].includes(token)) {
      if (booleans.has(token)) return false;
      booleans.add(token);
      continue;
    }
    if (["--target", "--title", "--notes-file"].includes(token)) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-") || values.has(token)) return false;
      values.set(token, value);
      index += 1;
      continue;
    }
    return false;
  }
  return (
    values.get("--target") === proof.headSha &&
    values.get("--title") === proof.tag &&
    piReleaseNotesFileMatches(projectRoot, proof, values.get("--notes-file")) &&
    booleans.has("--latest") &&
    booleans.has("--verify-tag")
  );
}

/** @description Um update de lifecycle só pode mergear sem CI quando o branch atual tem a forma
 * exata do helper E todo caminho commitado está no manifesto de arquivos do harness. Fail-closed
 * em qualquer dúvida de git/manifesto. Ported 1:1 de defaultIsLifecycleOnlyMerge (entry-gate.ts).
 * @param {string} projectRoot
 * @returns {boolean} */
export function piIsLifecycleOnlyMerge(projectRoot) {
  try {
    const branch = runGit(["branch", "--show-current"], projectRoot);
    if (!/^chore\/harness-lifecycle-(updating-harness|configuring-model-routing)-\d+$/.test(branch)) {
      return false;
    }
    const owned = new Set();
    for (const relativePath of [
      ".pi/.harness-owned-files.json",
      ".opencode/.harness-owned-files.json",
      ".claude/.harness-owned-files.json",
    ]) {
      const manifestPath = join(projectRoot, relativePath);
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest?.version !== 1 ||
        !Array.isArray(manifest.files) ||
        manifest.files.some(
          (file) =>
            typeof file !== "string" ||
            file.length === 0 ||
            file.startsWith("/") ||
            file.split("/").includes(".."),
        )
      ) {
        return false;
      }
      for (const file of manifest.files) owned.add(file);
    }
    if (owned.size === 0) return false;
    const remoteHead = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], projectRoot);
    if (!/^origin\/(main|master)$/.test(remoteHead)) return false;
    const changed = execFileSync("git", ["diff", "--name-only", "-z", `${remoteHead}...HEAD`], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    return changed.length > 0 && changed.every((file) => owned.has(file));
  } catch {
    return false;
  }
}

/**
 * @description Rail de bash da lane Pi, na ordem exata do entry-gate.ts:
 *   1. denylist de frota (só sob HARNESS_NOTIFY_PROJECT; módulo ausente = fail-open ruidoso);
 *   2. rail #808 de contaminação de fila (harness:* label vindo de rotina/subagente);
 *   3. advisory não-bloqueante (nunca nega; vai em decision.advisory / sink.metadata);
 *   4. gate-state da sessão (FAIL-OPEN: qualquer !ok vira {});
 *   5. gitState real só para comando de delivery (fail-open null);
 *   6. `gh pr merge` fail-CLOSED contra o rollup de CI, com a exceção lifecycle-only;
 *   7. decideBashDelivery (branch/zero-commits, regate, captura, real-file).
 * @param {{
 *   command?: unknown,
 *   projectRoot?: string,
 *   sessionId?: string|null,
 *   isSubagent?: boolean,
 *   env?: Record<string, string|undefined>,
 *   advisorySink?: { metadata?: Record<string, unknown> }|null,
 *   loadGateStateFn?: (root: string, opts: {sessionId?: string|null}) => object,
 *   gitStateFn?: () => object|null,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   listHandRecordsForFeatureFn?: (featureId: string) => unknown[],
 *   readMergeCheckRollupFn?: (target: string|null) => unknown,
 *   readMergeCheckEvidenceFn?: (target: string|null) => unknown,
 *   isLifecycleOnlyMergeFn?: () => boolean,
 *   classifyReleaseOnlyFn?: (root: string) => object,
 *   resolveReleaseProofFn?: (root: string) => object,
 *   readMergedReleaseEvidenceFn?: (headSha: string) => unknown,
 *   importDenylistFn?: () => Promise<object>,
 * }} input
 * @returns {Promise<{ok: boolean, decision: "allow"|"deny", reason: string, advisory?: string, details?: unknown}>}
 */
export async function decidePiBashGate(input = {}) {
  const projectRoot =
    typeof input.projectRoot === "string" && input.projectRoot.length > 0
      ? input.projectRoot
      : process.cwd();
  const env = input.env ?? process.env;
  const command = input.command;
  const commandText = typeof command === "string" ? command : "";
  const releaseMutation = isGitTagMutation(command) || isGhReleaseCreate(command) || isTagPushAttempt(command);

  // 1. Choke-point de frota (#516): re-checa o comando cru contra a denylist endurecida,
  // independente de qualquer permissão resolvida pelo host. Escopo deliberadamente restrito a
  // dispatch de frota (HARNESS_NOTIFY_PROJECT), como na lane OC.
  if (env.HARNESS_NOTIFY_PROJECT) {
    let decideDangerousBashDenylist = null;
    try {
      const importFn =
        typeof input.importDenylistFn === "function"
          ? input.importDenylistFn
          : () => import("../../shared/lib/dangerous-bash-denylist.mjs");
      ({ decideDangerousBashDenylist } = await importFn());
    } catch (err) {
      // Falha de INFRA deste backstop, não decisão de segurança: fail-open, mas RUIDOSO.
      console.error(
        `${PREFIX} denylist choke-point unavailable, allowing dispatch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof decideDangerousBashDenylist === "function") {
      const denylistDecision = decideDangerousBashDenylist(commandText);
      if (!denylistDecision.allow) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `${PREFIX} Blocked: ${denylistDecision.reason} (fleet bash denylist choke-point, ` +
            "independent of resolved permission.bash — issue #516).",
        };
      }
    }
  }

  // 2. Rail #808. Os dois sinais são necessários: uma sessão ROTINA (marcadores de env) e uma
  // sessão FILHA (o harvester é sempre despachado como filho). No Pi o segundo sinal vem de
  // ctx.sessionManager.getHeader().parentSession, resolvido pelo adaptador (isChildSession).
  const labelRailRelevant =
    detectHarnessLabelWrite(command) !== null || /\bgh\s+issue\s+create\b/.test(commandText);
  const routineSession = labelRailRelevant ? isRoutineSession(env) : false;
  const isSubagentForLabelRail =
    labelRailRelevant && !routineSession ? Boolean(input.isSubagent) : false;
  const labelDecision = decideBashHarnessLabel({
    command,
    isRoutine: routineSession,
    isSubagent: isSubagentForLabelRail,
  });
  if (labelDecision.decision === "deny") return labelDecision;

  // 3. Advisory — sempre allow. Vai no Decision (e no sink, quando o chamador oferece um).
  const advisoryDecision = decideBashAdvisory({
    command,
    cwd: projectRoot,
    isRoutine: routineSession || isSubagentForLabelRail,
  });
  applyAdvisory(advisoryDecision, input.advisorySink ?? null);
  const advisory =
    typeof advisoryDecision.advisory === "string" && advisoryDecision.advisory
      ? { advisory: advisoryDecision.advisory }
      : {};

  // 4. Gate-state — FAIL-OPEN total para bash (paridade CC/OC).
  const loadGateStateFn =
    typeof input.loadGateStateFn === "function" ? input.loadGateStateFn : loadPiGateStateFromDisk;
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.length > 0 ? input.sessionId : undefined;
  let loaded;
  try {
    loaded = loadGateStateFn(projectRoot, { sessionId: sessionId ?? null });
  } catch {
    loaded = { ok: false, reason: "gate-state load threw" };
  }
  const gateState = loaded && loaded.ok ? loaded.state : {};

  const isAncestorFn =
    typeof input.isAncestorFn === "function"
      ? input.isAncestorFn
      : (sha) => piIsAncestor(sha, projectRoot);
  const listHandRecordsForFeatureFn =
    typeof input.listHandRecordsForFeatureFn === "function"
      ? input.listHandRecordsForFeatureFn
      : (featureId) => listPiHandRecordsForFeature(projectRoot, featureId);

  // 5. Sonda git só para comando de delivery (shellout real, fail-open).
  const deliveryExtras = {};
  if (isDeliveryCommand(command)) {
    try {
      deliveryExtras.gitState =
        typeof input.gitStateFn === "function" ? input.gitStateFn() : piGitState(projectRoot);
    } catch {
      deliveryExtras.gitState = null;
    }
  }

  const releaseProof = isDeliveryCommand(command) || releaseMutation
    ? releaseProofForGate(input, projectRoot)
    : { ok: false, reason: "release proof not requested" };
  const releaseScope = deliveryMayUseReleaseScope(command, releaseProof)
    ? releaseOnlyScope({
        gateState,
        isAncestorFn,
        proof: releaseProof,
      })
    : { active: false, gateState, proof: null };

  if (isGitTagMutation(command)) {
    return exactPostMergeTagCommand(commandText, releaseProof)
      ? { ...ALLOW, ...advisory }
      : {
          ok: false,
          decision: "deny",
          reason: `${PREFIX} Blocked: release tag creation requires the exact verified post-merge version on origin/main.`,
          ...advisory,
        };
  }
  if (isGhReleaseCreate(command)) {
    return exactPostMergeReleaseCreate(commandText, releaseProof, projectRoot)
      ? { ...ALLOW, ...advisory }
      : {
          ok: false,
          decision: "deny",
          reason: `${PREFIX} Blocked: GitHub Release creation requires the exact verified post-merge tag and target commit.`,
          ...advisory,
        };
  }
  if (isTagPushAttempt(command)) {
    return exactPostMergeTagPush(commandText, releaseProof, projectRoot)
      ? { ...ALLOW, ...advisory }
      : {
          ok: false,
          decision: "deny",
          reason: `${PREFIX} Blocked: tag push requires literal 'git push origin <verified-tag>' after the verified release merge.`,
          ...advisory,
        };
  }

  // 6. `gh pr merge` é o único verbo de delivery que precisa de evidência externa. Fail-CLOSED.
  if (isGhPrMergeCommand(command)) {
    const isLifecycleOnlyMergeFn =
      typeof input.isLifecycleOnlyMergeFn === "function"
        ? input.isLifecycleOnlyMergeFn
        : () => piIsLifecycleOnlyMerge(projectRoot);
    const target = mergeTargetFromCommand(command);
    let evidence = null;
    if (target !== undefined) {
      if (typeof input.readMergeCheckEvidenceFn === "function") {
        evidence = input.readMergeCheckEvidenceFn(target);
      } else if (typeof input.readMergeCheckRollupFn === "function") {
        evidence = { statusCheckRollup: input.readMergeCheckRollupFn(target) };
      } else {
        evidence = piMergeCheckEvidence(target, projectRoot);
      }
    }
    const checkDecision =
      target === undefined
        ? { ok: false, reason: "PR target is ambiguous; merge is denied." }
        : decideMergeChecks(evidence?.statusCheckRollup);
    const allowsLifecycleWithoutCi =
      target === null &&
      checkDecision.ok === false &&
      "state" in checkDecision &&
      checkDecision.state === "missing" &&
      isLifecycleOnlyMergeFn();
    if (
      releaseScope.active &&
      !piReleaseMergeMatchesProof(releaseScope.proof, evidence)
    ) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} Blocked: release-only proof does not match the exact PR HEAD, branch, and base.`,
        ...advisory,
      };
    }
    if (!checkDecision.ok && !allowsLifecycleWithoutCi) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} Blocked: ${checkDecision.reason}`,
        ...advisory,
      };
    }
  }

  // 7. Rails de delivery puros.
  const delivery = decideBashDelivery({
    command,
    gateState: releaseScope.gateState,
    sessionId: sessionId ?? null,
    isAncestorFn,
    listHandRecordsForFeatureFn,
    ...deliveryExtras,
  });
  if (delivery.decision === "deny") return { ...delivery, ...advisory };
  return { ...ALLOW, ...advisory };
}

/**
 * @description Rail de dispatch de subagente da lane Pi, na ordem exata do entry-gate.ts:
 * papel traduzido por toOcRole → gate-state (fail-open só quando a reason começa com
 * 'gate-state'; identidade é fail-closed) → identidade do dispatch (marcador
 * [HARNESS_TASK_CONTEXT] do prompt + args) → decideEntryTask → reivindicação do dispatch-record
 * exato para mão que escreve (executor/sniper/test-author).
 * @param {{
 *   projectRoot?: string,
 *   sessionId?: string|null,
 *   subagentType?: unknown,
 *   toolArgs?: unknown,
 *   toolCallId?: unknown,
 *   env?: Record<string, string|undefined>,
 *   loadGateStateFn?: (root: string, opts: {sessionId?: string|null}) => object,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   claimDispatchFn?: (root: string, args: object, deps: object) => object,
 *   readCanonicalTaskPolicyFn?: (root: string, featureId: string, taskId: string) => object,
 *   readSpecDraftFn?: (context: object) => object,
 *   readSpecApprovalFn?: (context: object) => object,
 *   classifyReleaseOnlyFn?: (root: string) => object,
 *   resolveReleaseProofFn?: (root: string) => object,
 *   readMergedReleaseEvidenceFn?: (headSha: string) => unknown,
 * }} input
 * @returns {{ok: boolean, decision: "allow"|"deny", reason: string, details?: unknown}}
 */
export function decidePiDispatchGate(input = {}) {
  const projectRoot =
    typeof input.projectRoot === "string" && input.projectRoot.length > 0
      ? input.projectRoot
      : process.cwd();
  const env = input.env ?? process.env;
  const role = toOcRole(input.subagentType);
  const toolArgs =
    input.toolArgs && typeof input.toolArgs === "object" && !Array.isArray(input.toolArgs)
      ? input.toolArgs
      : {};
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.length > 0 ? input.sessionId : undefined;

  const loadGateStateFn =
    typeof input.loadGateStateFn === "function" ? input.loadGateStateFn : loadPiGateStateFromDisk;
  let loaded;
  try {
    loaded = loadGateStateFn(projectRoot, { sessionId: sessionId ?? null });
  } catch (err) {
    loaded = {
      ok: false,
      reason: err instanceof Error ? err.message : "gate-state load threw",
    };
  }
  // Fail-open SÓ quando o ARQUIVO de gate-state é ilegível/corrompido (#482): problema de infra
  // ao ler gate-state.json não é evidência de que o dispatch é inseguro. Identidade de sessão
  // ausente/insegura é outro problema — não sabemos de quem é o estado — e fica fail-CLOSED.
  const gateStateUnreadable =
    loaded && !loaded.ok && typeof loaded.reason === "string" && loaded.reason.startsWith("gate-state");
  if (loaded && !loaded.ok && isDeliveryRole(role)) {
    if (gateStateUnreadable) {
      console.error(`${PREFIX} gate-state unreadable, allowing dispatch: ${loaded.reason}`);
    } else {
      return { ok: false, decision: "deny", reason: `${PREFIX} ${loaded.reason}` };
    }
  }
  const gateState = loaded && loaded.ok ? loaded.state : {};

  const promptMarker = parseTaskDispatchIdentity(toolArgs.prompt);
  const identity = resolveHookIdentity({
    // O Pi não tem envelope de runtime com feature/task: o único campo confiável é o sessionId
    // do ctx.sessionManager; tudo o mais chega pelos args (não confiáveis) do dispatch.
    input: { sessionID: sessionId ?? "" },
    toolArgs,
    promptTaskId: promptMarker.ok ? promptMarker.taskId : "",
  });
  if (!identity.ok) {
    return { ok: false, decision: "deny", reason: `${PREFIX} ${identity.reason}` };
  }

  const optionalIds = extractPiFeatureTaskIds(toolArgs);
  const featureId =
    identity.featureIdSource === "runtime-envelope"
      ? identity.featureId
      : typeof gateState.feature_id === "string"
        ? gateState.feature_id
        : optionalIds.featureId;
  // O que ESTE dispatch declara como alvo de planejamento, independente do feature_id (possivelmente
  // velho) do gate-state — sem isso o featureMismatch do planner viraria tautologia.
  const dispatchFeatureId =
    identity.featureIdSource === "runtime-envelope" ? identity.featureId : optionalIds.featureId;
  const taskId = identity.taskId || optionalIds.taskId;
  const bareRole = toOcRole(input.subagentType);

  // `no_tests` não é um argumento de dispatch: é uma propriedade validada da tarefa estável.
  // Só o executor normal a consome; test-author continua sem caminhos para produzir e sniper
  // continua no rail de fidelidade de correção. O hash volta no claim para não liberar uma tarefa
  // cuja política mudou entre esta leitura e a reivindicação atômica do escopo.
  let canonicalNoTests = false;
  let noTestsPlanHash = "";
  if (isExecutorRole(bareRole) && featureId && taskId) {
    const readPolicy =
      typeof input.readCanonicalTaskPolicyFn === "function"
        ? input.readCanonicalTaskPolicyFn
        : readPiCanonicalTaskPolicy;
    const policy = readPolicy(projectRoot, featureId, taskId);
    if (!policy?.ok) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} Blocked: canonical task policy unavailable: ${String(policy?.reason ?? "unknown")}`,
      };
    }
    canonicalNoTests = policy.noTests === true;
    if (canonicalNoTests) {
      if (typeof policy.planHash !== "string" || policy.planHash.length === 0) {
        return { ok: false, decision: "deny", reason: `${PREFIX} Blocked: canonical no_tests policy lacks plan hash.` };
      }
      noTestsPlanHash = policy.planHash;
    }
  }

  const isAncestorFn =
    typeof input.isAncestorFn === "function"
      ? input.isAncestorFn
      : (sha) => piIsAncestor(sha, projectRoot);

  const releaseProof = bareRole === "shipper"
    ? releaseProofForGate(input, projectRoot)
    : { ok: false, reason: "release proof not requested" };
  const releaseScope = bareRole === "shipper"
    ? releaseOnlyScope({
        gateState,
        isAncestorFn,
        proof: releaseProof,
      })
    : { active: false, gateState, proof: null };

  if (isWritingHandRole(input.subagentType) && taskId && Array.isArray(gateState.regate_pending)) {
    const own = formatFeatureTaskEntry(featureId, taskId);
    const unresolvedOther = gateState.regate_pending.some(
      (pending) => typeof pending === "string" && pending !== own &&
        !matchesAbsolution(pending, gateState.regate_passed, isAncestorFn),
    );
    if (unresolvedOther) {
      return { ok: false, decision: "deny", reason: `${PREFIX} Blocked: another task requires adversary re-gate before writing hand dispatch.` };
    }
  }

  // decideEntryTask é compartilhado com OC e ainda não conhece no_tests. A cópia é efêmera e
  // localizada: só satisfaz o seu consumer de fidelidade para a tarefa canônica sem testes;
  // não persiste nem remove qualquer outro rail do gate-state original.
  const entryGateState = canonicalNoTests
    ? {
        ...releaseScope.gateState,
        fidelity_pass: [
          ...(Array.isArray(gateState.fidelity_pass) ? gateState.fidelity_pass : []),
          formatFeatureTaskEntry(featureId, taskId),
        ],
      }
    : releaseScope.gateState;
  const entryDecision = decideEntryTask({
    subagentType: role,
    gateState: entryGateState,
    featureId,
    dispatchFeatureId,
    taskId,
    isAncestorFn,
    allowAdversaryBeforeBrainstorm: role === "adversary",
  });
  if (entryDecision.decision === "deny") return entryDecision;

  // O único desvio Pi da ordem legada é o adversary sobre uma draft host-owned, antes da
  // aprovação humana. Nenhum outro papel ganha essa exceção. Fazemos essa checagem DEPOIS da
  // cerimônia comum para preservar as mensagens de triagem ausente/ordem do pipeline.
  if (role === "adversary" && gateState.spec_status === "draft") {
    const readDraft = typeof input.readSpecDraftFn === "function" ? input.readSpecDraftFn : readPiSpecDraft;
    const draft = readDraft({ projectRoot, sessionId, featureId });
    if (!draft?.ok) {
      return { ok: false, decision: "deny", reason: `${PREFIX} Blocked: ${String(draft?.reason ?? "current canonical spec draft required")}` };
    }
  }
  if (role === "planner") {
    const readApproval = typeof input.readSpecApprovalFn === "function" ? input.readSpecApprovalFn : readPiSpecApproval;
    const approved = readApproval({ projectRoot, sessionId, featureId });
    if (!approved?.ok) {
      return { ok: false, decision: "deny", reason: `${PREFIX} Blocked: ${String(approved?.reason ?? "current adversary-reviewed spec required")}` };
    }
  }

  if (isWritingHandRole(input.subagentType)) {
    const callId = typeof input.toolCallId === "string" ? input.toolCallId : "";
    if (!sessionId || !callId || !taskId || !featureId) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} exact dispatch identity required for writing hand`,
      };
    }

    // A fidelidade não pode vazar de uma task para outra. A decisão compartilhada preserva
    // compatibilidade feature-wide para outras lanes; aqui, onde a mão é amarrada a um
    // dispatch-record por tarefa, executor e sniper consomem o fato exato.
    if (
      (isExecutorRole(bareRole) || isSniperRole(bareRole)) &&
      !canonicalNoTests &&
      !hasFidelityPass(gateState.fidelity_pass, featureId, taskId)
    ) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} Blocked: ${bareRole} requires task-scoped fidelity-pass for ${featureId}/${taskId} before spawn.`,
      };
    }
    const claimFn =
      typeof input.claimDispatchFn === "function" ? input.claimDispatchFn : claimPiDispatchForRuntime;
    const claimed = claimFn(
      projectRoot,
      {
        sessionId,
        callId,
        role: input.subagentType,
        taskId,
        featureId,
        ...(noTestsPlanHash ? { expectedPlanHash: noTestsPlanHash } : {}),
      },
      { env, isAncestorFn },
    );
    if (!claimed || !claimed.ok) {
      return {
        ok: false,
        decision: "deny",
        reason: `${PREFIX} exact dispatch record rejected: ${claimed?.reason ?? "unknown"}`,
      };
    }
  }

  return { ...ALLOW, reason: "entry-allow" };
}

/**
 * @description feature_id / taskId opcionais vindos dos args do dispatch (aninhados em `input`
 * também). O task_id oficial de resume do host nunca é lido como task do plano. Nunca lança.
 * @param {unknown} toolArgs
 * @returns {{featureId?: string, taskId?: string}}
 */
export function extractPiFeatureTaskIds(toolArgs) {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return {};
  const a = /** @type {Record<string, unknown>} */ (toolArgs);
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? /** @type {Record<string, unknown>} */ (a.input)
      : null;
  const featureRaw = a.feature_id ?? a.featureId ?? a.feature ?? nested?.feature_id ?? nested?.featureId;
  const taskRaw = a.taskId ?? a.task ?? nested?.taskId ?? nested?.task;
  return {
    featureId: typeof featureRaw === "string" ? featureRaw : undefined,
    taskId: typeof taskRaw === "string" ? taskRaw : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Conclusão de mão (tool_execution_end)                               *
 * ------------------------------------------------------------------ */

/** @description Desfecho que torna a task elegível a captura independente. @param {unknown} outcome */
function isCaptureEligibleOutcome(outcome) {
  return outcome === "DONE" || outcome === "DONE_WITH_CONCERNS";
}

/** @description Lê o hand-record exato da lane Pi reusando listPiHandRecordsForFeature (o único
 * leitor exportado pela peça state-records); null quando não existe.
 * @param {string} projectRoot
 * @param {{featureId: string, sessionId: string, taskId: string}} ids
 * @returns {object|null} */
function readPiHandRecord(projectRoot, { featureId, sessionId, taskId }) {
  for (const entry of listPiHandRecordsForFeature(projectRoot, featureId)) {
    if (entry.sessionId === sessionId && entry.taskId === taskId) return entry.record;
  }
  return null;
}

/** @description Preserva só o fato terminal declarado pela Task; evidência de git nunca promove.
 * Mesma tabela de resolveOcHandOutcome (lane OC).
 * @param {string|null} parsedStatus
 * @param {string} outputText
 * @returns {string} */
function resolvePiHandOutcome(parsedStatus, outputText) {
  if (parsedStatus === "DONE" || parsedStatus === "DONE_WITH_CONCERNS") return parsedStatus;
  if (parsedStatus === "NEEDS_CONTEXT") return "NEEDS_CONTEXT";
  if (parsedStatus === null && isCapacityExhaustedOutput(outputText)) return "CAPACITY_EXHAUSTED";
  return "BLOCKED";
}

/** @description Resolve o HEAD do projeto; falha e saída vazia não são fatais.
 * @param {string} projectRoot
 * @returns {string|null} */
function resolvePiHeadSha(projectRoot) {
  try {
    return runGit(["rev-parse", "HEAD"], projectRoot) || null;
  } catch {
    return null;
  }
}

/** @description Remove uma entrada exata de uma lista de tasks do gate-state.
 * @param {unknown} entries @param {string} bare @returns {unknown[]} */
function removeTaskEntry(entries, bare) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry !== bare);
}

/**
 * @description Persiste o registro terminal da mão sob `.pi/harness/state/` e carimba o fato de
 * conclusão elegível a captura em hand_finished, sob withGateStateLock. Espelha
 * recordHandFinished (core/opencode/plugin/lib/host-hand-capture.mjs), que NÃO pode ser reusado
 * por import: ele resolve caminhos por path-helpers.mjs com runtime 'opencode' e leria/escreveria
 * em `.opencode/plans/.state/`. Toda a lógica pura (formatFeatureTaskEntry, checkScope,
 * checkFrozen, mergeGateStatePatch, withGateStateLock) É reusada por import.
 * @param {{projectRoot: string, sessionId: string, featureId: string, taskId: string, role: string,
 *   producerCallId: string, outcome: string, touchedPaths: string[], freezeCommitSha: string|null}} input
 * @returns {{ok: boolean, recorded: boolean, reason?: string}}
 */
export function recordPiHandFinished(input) {
  try {
    const {
      projectRoot,
      sessionId,
      featureId,
      taskId,
      role,
      producerCallId,
      outcome,
      touchedPaths,
      freezeCommitSha,
    } = input ?? {};
    if (
      ![projectRoot, sessionId, featureId, taskId, role, producerCallId, outcome].every(
        (value) => typeof value === "string" && value,
      )
    ) {
      return { ok: false, recorded: false, reason: "completion identity missing" };
    }
    const exactProducer = () => {
      const producer = readPiDispatchRecord(projectRoot, {
        parentSessionId: sessionId,
        callId: producerCallId,
      });
      if (
        !producer.ok ||
        producer.record.feature_id !== featureId ||
        producer.record.task_id !== taskId ||
        toOcRole(producer.record.role) !== toOcRole(role)
      ) {
        return null;
      }
      return producer.record;
    };
    if (exactProducer() === null) {
      return { ok: false, recorded: false, reason: "exact producer dispatch record required" };
    }
    const state = piGateStatePath({ projectRoot, sessionId });
    if (!state.ok) return { ok: false, recorded: false, reason: state.reason };

    let outcomeResult = { ok: false, recorded: false, reason: "completion record failed" };
    let supersededProducerCallId = "";
    const locked = withGateStateLock(state.path, (gateState) => {
      const producer = exactProducer();
      if (producer === null) {
        outcomeResult = { ok: false, recorded: false, reason: "exact producer dispatch record required" };
        return gateState;
      }
      const existing = readPiHandRecord(projectRoot, { featureId, sessionId, taskId });
      const bare = formatFeatureTaskEntry(featureId, taskId);
      const stamp = (eligible) => {
        const pruned = { ...gateState, hand_finished: removeTaskEntry(gateState.hand_finished, bare) };
        const merged = mergeGateStatePatch(pruned, { hand_finished: eligible ? [bare] : [] });
        return merged.ok ? merged.state : pruned;
      };
      if (existing?.producerCallId === producerCallId) {
        outcomeResult = { ok: true, recorded: false, reason: "completion producer already recorded" };
        return stamp(isCaptureEligibleOutcome(existing.outcome));
      }
      const priorClaimedAt =
        typeof existing?.producerClaimedAt === "string"
          ? Date.parse(existing.producerClaimedAt)
          : Number.NEGATIVE_INFINITY;
      const claimedAt = Date.parse(producer.claimed_at);
      if (!Number.isFinite(claimedAt)) {
        outcomeResult = { ok: false, recorded: false, reason: "producer claim timestamp invalid" };
        return gateState;
      }
      if (Number.isFinite(priorClaimedAt) && priorClaimedAt >= claimedAt) {
        outcomeResult = { ok: true, recorded: false, reason: "newer completion producer already recorded" };
        return gateState;
      }
      const now = new Date().toISOString();
      const allowed = [
        ...(Array.isArray(producer.scope_paths) ? producer.scope_paths : []),
        ...(Array.isArray(producer.allowed_writes) ? producer.allowed_writes : []),
      ];
      const touched = Array.isArray(touchedPaths)
        ? touchedPaths.filter((item) => typeof item === "string")
        : [];
      const scope = checkScope(touched, allowed);
      const frozen = checkFrozen(touched, Array.isArray(producer.frozen_paths) ? producer.frozen_paths : []);
      const effectiveOutcome = scope.length > 0 || frozen.length > 0 ? "BLOCKED" : outcome;
      const record = {
        featureId,
        taskId,
        sessionId,
        producerCallId,
        producerClaimedAt: producer.claimed_at,
        freezeCommitSha: typeof freezeCommitSha === "string" && freezeCommitSha ? freezeCommitSha : null,
        outcome: effectiveOutcome,
        touchedPaths: touched,
        scopeViolations: scope,
        frozenViolations: frozen,
        agent: role,
        startedAt: existing?.startedAt ?? now,
        finishedAt: now,
        writtenBy: "host-hand-finished",
      };
      const written = writePiHandRecord({
        roots: { projectRoot, sessionId, featureId },
        taskId,
        record,
      });
      if (!written.ok) {
        outcomeResult = { ok: false, recorded: false, reason: written.reason };
        return gateState;
      }
      if (typeof existing?.producerCallId === "string" && existing.producerCallId !== producerCallId) {
        supersededProducerCallId = existing.producerCallId;
      }
      outcomeResult = { ok: true, recorded: true };
      return stamp(isCaptureEligibleOutcome(effectiveOutcome));
    });
    if (!locked.ok) return { ok: false, recorded: false, reason: locked.reason };
    if (supersededProducerCallId) {
      removePiDispatchRecord(projectRoot, { sessionId, callId: supersededProducerCallId });
    }
    return outcomeResult;
  } catch (error) {
    return {
      ok: false,
      recorded: false,
      reason: error instanceof Error ? error.message : "recordPiHandFinished failed",
    };
  }
}

/**
 * @description Normaliza um resultado terminal de subagente do Pi e o persiste pela autoridade do
 * produtor exato. Espelho de recordTaskCompletion (lane OC) com os caminhos da lane Pi.
 * @param {{projectRoot?: string, sessionId?: string, featureId?: string, taskId?: string,
 *   role?: string, producerCallId?: string, outputText?: unknown, background?: boolean}} input
 * @returns {{ok: boolean, terminal: boolean, recorded: boolean, capturePending?: boolean, reason?: string}}
 */
export function recordPiTaskCompletion(input = {}) {
  try {
    const outputText = String(input?.outputText ?? "");
    if (input?.background === true && /<task\b[^>]*\bstate=["']running["']/i.test(outputText)) {
      return { ok: true, terminal: false, recorded: false, reason: "background task still running" };
    }
    const projectRoot = input.projectRoot;
    const producer = readPiDispatchRecord(projectRoot, {
      parentSessionId: input.sessionId,
      callId: input.producerCallId,
    });
    const touched = excludePiHarnessArtifacts(pathsChangedSinceBaseline(
      projectRoot,
      producer.ok ? producer.record.worktree_baseline : null,
    ));
    const outcome = resolvePiHandOutcome(parseHandStatusFromOutput(outputText), outputText);
    const recorded = recordPiHandFinished({
      projectRoot,
      sessionId: input.sessionId,
      featureId: input.featureId,
      taskId: input.taskId,
      role: input.role,
      producerCallId: input.producerCallId,
      outcome,
      touchedPaths: touched,
      freezeCommitSha: resolvePiHeadSha(projectRoot),
    });
    const persisted =
      typeof projectRoot === "string" &&
      typeof input.featureId === "string" &&
      typeof input.sessionId === "string" &&
      typeof input.taskId === "string"
        ? readPiHandRecord(projectRoot, {
            featureId: input.featureId,
            sessionId: input.sessionId,
            taskId: input.taskId,
          })
        : null;
    const capturePending =
      recorded.ok === true &&
      isCaptureEligibleOutcome(persisted?.outcome) &&
      persisted?.producerCallId === input.producerCallId;
    return { ...recorded, terminal: true, capturePending };
  } catch (error) {
    return {
      ok: false,
      terminal: true,
      recorded: false,
      reason: error instanceof Error ? error.message : "recordPiTaskCompletion failed",
    };
  }
}

export { hasFidelityPass, isDeliveryCommand, isRoutineSession };

export default {
  decidePiBashGate,
  decidePiDispatchGate,
  excludePiHarnessArtifacts,
  extractPiFeatureTaskIds,
  isWritingHandRole,
  piGitState,
  piIsAncestor,
  piIsLifecycleOnlyMerge,
  piMergeCheckRollup,
  piMergeCheckEvidence,
  recordPiHandFinished,
  recordPiTaskCompletion,
};
