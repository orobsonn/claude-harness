/**
 * @description Prova local, fail-closed, de que o HEAD é um commit exclusivamente de release.
 * A prova nunca persiste estado nem substitui rails gerais: ela só permite ao adaptador Pi
 * desconsiderar obrigações de tasks cuja absolvição aponta exclusivamente para SHAs antigos,
 * comprovadamente fora da ancestry do HEAD atual após um squash.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { decideMergeChecks } from "../vendor/shared/lib/merge-check-gate.mjs";

const RELEASE_BRANCH = /^chore\/release-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_SUBJECT = /^chore: release v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(#([1-9]\d*)\))?$/;
const TASK = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GIT_SHA = /^[0-9a-f]{7,64}$/;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIMPLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function isReleasePleaseManaged(projectRoot) {
  if (
    pathEntryExists(join(projectRoot, "release-please-config.json")) ||
    pathEntryExists(join(projectRoot, ".release-please-manifest.json"))
  ) {
    return true;
  }
  const workflows = join(projectRoot, ".github", "workflows");
  if (!pathEntryExists(workflows)) return false;
  try {
    return readdirSync(workflows, { withFileTypes: true }).some((entry) => {
      if (/release[-_]?please/i.test(entry.name)) return true;
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) return false;
      return /(?:googleapis\/release-please-action|\brelease-please-action\b)/i.test(
        readFileSync(join(workflows, entry.name), "utf8"),
      );
    });
  } catch {
    return true;
  }
}

function isSimpleVersionIncrease(before, after) {
  const left = typeof before === "string" ? SIMPLE_VERSION.exec(before) : null;
  const right = typeof after === "string" ? SIMPLE_VERSION.exec(after) : null;
  if (!left || !right) return false;
  for (let index = 1; index <= 3; index += 1) {
    const previous = BigInt(left[index]);
    const next = BigInt(right[index]);
    if (next > previous) return true;
    if (next < previous) return false;
  }
  return false;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitBlob(root, revision, path) {
  return execFileSync("git", ["show", `${revision}:${path}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitHasBlob(root, revision, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${path}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function sameExceptVersion(before, after) {
  if (!before || typeof before !== "object" || Array.isArray(before)) return false;
  if (!after || typeof after !== "object" || Array.isArray(after)) return false;
  const left = structuredClone(before);
  const right = structuredClone(after);
  delete left.version;
  delete right.version;
  return isDeepStrictEqual(left, right);
}

function sameLockExceptReleaseVersions(before, after) {
  if (!before || typeof before !== "object" || Array.isArray(before)) return false;
  if (!after || typeof after !== "object" || Array.isArray(after)) return false;
  const left = structuredClone(before);
  const right = structuredClone(after);
  delete left.version;
  delete right.version;
  if (!left.packages?.[""] || !right.packages?.[""]) return false;
  delete left.packages[""].version;
  delete right.packages[""].version;
  return isDeepStrictEqual(left, right);
}

function parseChangelog(text) {
  const heading = /^## \[([^\]]+)\][^\n]*(?:\n|$)/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length === 0) return null;
  return {
    preamble: text.slice(0, matches[0].index),
    sections: matches.map((match, index) => {
      const start = match.index;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      const headingEnd = start + match[0].length;
      return {
        label: match[1],
        heading: match[0],
        body: text.slice(headingEnd, end),
        raw: text.slice(start, end),
      };
    }),
  };
}

function emptyUnreleasedBody(body) {
  return body
    .replace(/^### (?:Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/gm, "")
    .trim() === "";
}

function changelogReleaseBlock(beforeText, afterText, version) {
  const before = parseChangelog(beforeText);
  const after = parseChangelog(afterText);
  if (!before || !after || before.preamble !== after.preamble) return null;
  if (before.sections.some((section) => section.label === version)) return null;
  const targets = after.sections.filter((section) => section.label === version);
  if (targets.length !== 1 || targets[0].body.trim() === "") return null;
  const targetIndex = after.sections.findIndex((section) => section.label === version);
  if (targetIndex !== 0 && !(targetIndex === 1 && after.sections[0]?.label === "Unreleased")) {
    return null;
  }

  const withoutTarget = after.sections
    .filter((section) => section.label !== version)
    .map((section) => section.raw);
  if (isDeepStrictEqual(withoutTarget, before.sections.map((section) => section.raw))) {
    return targets[0].raw;
  }

  if (
    before.sections[0]?.label !== "Unreleased" ||
    after.sections[0]?.label !== "Unreleased" ||
    after.sections[1]?.label !== version ||
    !emptyUnreleasedBody(after.sections[0].body) ||
    after.sections[1].body !== before.sections[0].body
  ) {
    return null;
  }
  return isDeepStrictEqual(
    after.sections.slice(2).map((section) => section.raw),
    before.sections.slice(1).map((section) => section.raw),
  ) ? targets[0].raw : null;
}

function verifyReleaseFiles(projectRoot, baseSha, headSha, version) {
  const changed = execFileSync(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", headSha],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).split("\0").filter(Boolean);
  const changedSet = new Set(changed);
  if (
    changedSet.size !== changed.length ||
    !changedSet.has("package.json") ||
    !changedSet.has("CHANGELOG.md") ||
    changed.some((path) => !["package.json", "package-lock.json", "CHANGELOG.md"].includes(path))
  ) {
    return { ok: false, reason: "release commit changes files outside the release manifest" };
  }

  const beforePackage = JSON.parse(gitBlob(projectRoot, baseSha, "package.json"));
  const afterPackage = JSON.parse(gitBlob(projectRoot, headSha, "package.json"));
  if (
    !isSimpleVersionIncrease(beforePackage.version, version) ||
    afterPackage.version !== version ||
    !sameExceptVersion(beforePackage, afterPackage)
  ) {
    return { ok: false, reason: "package.json is not a version-only release change" };
  }

  const beforeHasLock = gitHasBlob(projectRoot, baseSha, "package-lock.json");
  const afterHasLock = gitHasBlob(projectRoot, headSha, "package-lock.json");
  if (beforeHasLock !== afterHasLock) {
    return { ok: false, reason: "package-lock.json was added or removed by release" };
  }
  if (beforeHasLock) {
    const beforeLock = JSON.parse(gitBlob(projectRoot, baseSha, "package-lock.json"));
    const afterLock = JSON.parse(gitBlob(projectRoot, headSha, "package-lock.json"));
    if (
      beforeLock.version !== beforePackage.version ||
      beforeLock.packages?.[""]?.version !== beforePackage.version ||
      afterLock.version !== version ||
      afterLock.packages?.[""]?.version !== version ||
      !sameLockExceptReleaseVersions(beforeLock, afterLock)
    ) {
      return { ok: false, reason: "package-lock.json is not a root-version-only release change" };
    }
  }

  const releaseNotes = changelogReleaseBlock(
    gitBlob(projectRoot, baseSha, "CHANGELOG.md"),
    gitBlob(projectRoot, headSha, "CHANGELOG.md"),
    version,
  );
  if (releaseNotes === null) {
    return { ok: false, reason: "CHANGELOG.md is not a preserving insertion for the release version" };
  }
  return { ok: true, releaseNotes };
}

/**
 * @param {string} projectRoot
 * @returns {{ok:true,branch:string,version:string,headSha:string,baseSha:string,baseBranch:"main"}|{ok:false,reason:string}}
 */
export function classifyPiReleaseOnly(projectRoot) {
  try {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      return { ok: false, reason: "project root missing" };
    }
    if (isReleasePleaseManaged(projectRoot)) {
      return { ok: false, reason: "manual release exception is disabled for release-please repositories" };
    }
    if (git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      return { ok: false, reason: "release worktree is not clean" };
    }

    const branch = git(projectRoot, ["branch", "--show-current"]);
    const match = RELEASE_BRANCH.exec(branch);
    if (!match) return { ok: false, reason: "release branch is not exact" };
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (git(projectRoot, ["log", "-1", "--format=%s"]) !== `chore: release v${version}`) {
      return { ok: false, reason: "release commit subject does not match branch version" };
    }

    const remoteHead = git(projectRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead !== "origin/main") {
      return { ok: false, reason: "origin/main is not the known default base" };
    }
    const headSha = git(projectRoot, ["rev-parse", "HEAD"]);
    const baseSha = git(projectRoot, ["rev-parse", "origin/main"]);
    if (
      git(projectRoot, ["rev-parse", "HEAD^"]) !== baseSha ||
      git(projectRoot, ["rev-list", "--count", "origin/main..HEAD"]) !== "1"
    ) {
      return { ok: false, reason: "release HEAD is not exactly one commit above origin/main" };
    }

    const files = verifyReleaseFiles(projectRoot, baseSha, headSha, version);
    if (!files.ok) return files;

    return { ok: true, branch, version, headSha, baseSha, baseBranch: "main" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `release-only proof unavailable: ${error.message}` : "release-only proof unavailable",
    };
  }
}

/**
 * @description Prova o release commit já mergeado e publicado em origin/main contra o PR exato.
 * @param {string} projectRoot
 * @param {unknown} evidence
 */
function classifyPiPostMergeCandidate(projectRoot) {
  try {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      return { ok: false, reason: "project root missing" };
    }
    if (isReleasePleaseManaged(projectRoot)) {
      return { ok: false, reason: "manual release exception is disabled for release-please repositories" };
    }
    if (git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      return { ok: false, reason: "release worktree is not clean" };
    }
    if (git(projectRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) !== "origin/main") {
      return { ok: false, reason: "origin/main is not the known default base" };
    }
    if (git(projectRoot, ["branch", "--show-current"]) !== "main") {
      return { ok: false, reason: "post-merge release is not checked out on main" };
    }
    const headSha = git(projectRoot, ["rev-parse", "HEAD"]);
    if (headSha !== git(projectRoot, ["rev-parse", "origin/main"])) {
      return { ok: false, reason: "post-merge HEAD does not equal origin/main" };
    }
    const subjectMatch = RELEASE_SUBJECT.exec(git(projectRoot, ["log", "-1", "--format=%s"]));
    if (!subjectMatch) {
      return { ok: false, reason: "post-merge commit subject is not an exact release subject" };
    }
    const version = `${subjectMatch[1]}.${subjectMatch[2]}.${subjectMatch[3]}`;
    const baseSha = git(projectRoot, ["rev-parse", "HEAD^"]);
    const files = verifyReleaseFiles(projectRoot, baseSha, headSha, version);
    if (!files.ok) return files;
    return {
      ok: true,
      phase: "post-merge",
      branch: "main",
      version,
      tag: `v${version}`,
      headSha,
      baseSha,
      baseBranch: "main",
      releaseNotes: files.releaseNotes,
      subjectPrNumber: subjectMatch[4] ? Number(subjectMatch[4]) : null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `post-merge release proof unavailable: ${error.message}` : "post-merge release proof unavailable",
    };
  }
}

export function classifyPiPostMergeRelease(projectRoot, evidence) {
  try {
    const candidate = classifyPiPostMergeCandidate(projectRoot);
    if (!candidate.ok) return candidate;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      return { ok: false, reason: "merged release PR evidence unavailable" };
    }
    const pr = /** @type {Record<string, unknown>} */ (evidence);
    const number = pr.number;
    const releaseHeadSha = pr.headRefOid;
    const releaseBranch = typeof pr.headRefName === "string" ? pr.headRefName : "";
    const branchMatch = RELEASE_BRANCH.exec(releaseBranch);
    if (
      !branchMatch ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      typeof releaseHeadSha !== "string" ||
      !FULL_GIT_SHA.test(releaseHeadSha)
    ) {
      return { ok: false, reason: "merged release PR identity invalid" };
    }
    const version = `${branchMatch[1]}.${branchMatch[2]}.${branchMatch[3]}`;
    const mergeOid =
      pr.mergeCommit && typeof pr.mergeCommit === "object" && !Array.isArray(pr.mergeCommit)
        ? /** @type {Record<string, unknown>} */ (pr.mergeCommit).oid
        : null;
    const mergedAt = typeof pr.mergedAt === "string" ? Date.parse(pr.mergedAt) : Number.NaN;
    if (
      pr.state !== "MERGED" ||
      !Number.isFinite(mergedAt) ||
      mergeOid !== candidate.headSha ||
      pr.baseRefName !== "main" ||
      version !== candidate.version ||
      pr.title !== `chore: release v${version}` ||
      !decideMergeChecks(pr.statusCheckRollup).ok ||
      (candidate.subjectPrNumber !== null && candidate.subjectPrNumber !== number)
    ) {
      return { ok: false, reason: "merged release PR does not match HEAD, base, title, or green CI" };
    }
    const { subjectPrNumber: _subjectPrNumber, ...proof } = candidate;
    return {
      ...proof,
      releaseBranch,
      releaseHeadSha,
      prNumber: number,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `post-merge release proof unavailable: ${error.message}` : "post-merge release proof unavailable",
    };
  }
}

/** @description Resolve o PR mergeado associado exatamente ao HEAD. Leitura host-only, fail-closed. */
export function readPiMergedReleaseEvidence(projectRoot, headSha) {
  try {
    if (!GIT_SHA.test(headSha)) return null;
    const output = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--search",
        headSha,
        "--limit",
        "20",
        "--json",
        "number,title,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,statusCheckRollup",
      ],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    const rows = JSON.parse(output);
    if (!Array.isArray(rows)) return null;
    const exact = rows.filter((row) => row?.mergeCommit?.oid === headSha);
    return exact.length === 1 ? exact[0] : null;
  } catch {
    return null;
  }
}

/** @description Prova compartilhada para consumidores host-owned (entry gate, memory e shipper). */
export function resolvePiReleaseProof(projectRoot, { readMergedReleaseEvidenceFn } = {}) {
  try {
    const pre = classifyPiReleaseOnly(projectRoot);
    if (pre.ok) {
      return { ...pre, phase: "pre-merge", tag: `v${pre.version}` };
    }
    const candidate = classifyPiPostMergeCandidate(projectRoot);
    if (!candidate.ok) return candidate;
    const readEvidence =
      typeof readMergedReleaseEvidenceFn === "function"
        ? readMergedReleaseEvidenceFn
        : (sha) => readPiMergedReleaseEvidence(projectRoot, sha);
    return classifyPiPostMergeRelease(projectRoot, readEvidence(candidate.headSha));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "release proof unavailable" };
  }
}

function markerArray(state, key) {
  if (!(key in state)) return { ok: true, entries: [] };
  if (!Array.isArray(state[key]) || state[key].some((item) => typeof item !== "string")) {
    return { ok: false, entries: [] };
  }
  return { ok: true, entries: state[key] };
}

function isOldQualifiedTask(task, qualified, isAncestorFn) {
  if (!TASK.test(task)) return false;
  const prefix = `${task}@`;
  const shas = qualified
    .filter((entry) => entry.startsWith(prefix) && entry.length > prefix.length)
    .map((entry) => entry.slice(prefix.length));
  if (shas.length === 0 || shas.some((sha) => !GIT_SHA.test(sha))) return false;
  for (const sha of shas) {
    try {
      if (isAncestorFn(sha) !== false) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @description Copia o estado e remove somente obrigações com prova SHA de lineage abandonada.
 * @param {unknown} gateState
 * @param {(sha:string)=>boolean|null} isAncestorFn
 */
export function scopePiReleaseOnlyTaskState(gateState, isAncestorFn) {
  try {
    if (!gateState || typeof gateState !== "object" || Array.isArray(gateState)) {
      return { ok: false, reason: "gate-state is not an object" };
    }
    if (typeof isAncestorFn !== "function") {
      return { ok: false, reason: "ancestry proof is unavailable" };
    }
    const state = /** @type {Record<string, unknown>} */ (gateState);
    const pending = markerArray(state, "regate_pending");
    const passed = markerArray(state, "regate_passed");
    const finished = markerArray(state, "hand_finished");
    const captured = markerArray(state, "capture_verified");
    if (![pending, passed, finished, captured].every((item) => item.ok)) {
      return { ok: false, reason: "task provenance markers are malformed" };
    }

    const oldPending = pending.entries.filter((task) =>
      isOldQualifiedTask(task, passed.entries, isAncestorFn),
    );
    const oldFinished = finished.entries.filter((task) =>
      isOldQualifiedTask(task, captured.entries, isAncestorFn),
    );
    const ignoredTasks = [...new Set([...oldPending, ...oldFinished])].sort();
    return {
      ok: true,
      state: {
        ...state,
        ...(pending.entries.length > 0 || "regate_pending" in state
          ? { regate_pending: pending.entries.filter((task) => !oldPending.includes(task)) }
          : {}),
        ...(finished.entries.length > 0 || "hand_finished" in state
          ? { hand_finished: finished.entries.filter((task) => !oldFinished.includes(task)) }
          : {}),
      },
      ignoredTasks,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "task provenance proof failed" };
  }
}

/** @description Confirma que o PR observado é exatamente o release HEAD/base provado localmente. */
export function piReleaseMergeMatchesProof(proof, evidence) {
  return Boolean(
    proof?.ok === true &&
      evidence &&
      typeof evidence === "object" &&
      evidence.headRefOid === proof.headSha &&
      evidence.headRefName === proof.branch &&
      evidence.baseRefName === proof.baseBranch &&
      evidence.baseRefOid === proof.baseSha,
  );
}

export default {
  classifyPiReleaseOnly,
  classifyPiPostMergeRelease,
  readPiMergedReleaseEvidence,
  resolvePiReleaseProof,
  scopePiReleaseOnlyTaskState,
  piReleaseMergeMatchesProof,
};
