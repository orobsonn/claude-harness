/** @description Prova de release-only sobre repositórios Git reais e escopo efêmero de tasks antigas. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function subject() {
  const unavailable = {
    classifyPiReleaseOnly: () => ({ ok: false, reason: "release-only module unavailable" }),
    classifyPiPostMergeRelease: () => ({ ok: false, reason: "release-only module unavailable" }),
    scopePiReleaseOnlyTaskState: () => ({ ok: false, reason: "release-only module unavailable" }),
    piReleaseMergeMatchesProof: () => false,
  };
  try {
    return { ...unavailable, ...(await import("./release-only.mjs")) };
  } catch (error) {
    return {
      ...unavailable,
      classifyPiReleaseOnly: () => ({
        ok: false,
        reason: `release-only module unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
}

function mergeReleaseFixture(f, { number = 42, ci = [{ conclusion: "SUCCESS" }] } = {}) {
  git(f.root, ["switch", "-q", "main"]);
  git(f.root, ["merge", "-q", "--squash", "chore/release-1.2.4"]);
  git(f.root, ["commit", "-q", "-m", `chore: release v1.2.4 (#${number})`]);
  const headSha = git(f.root, ["rev-parse", "HEAD"]);
  git(f.root, ["update-ref", "refs/remotes/origin/main", headSha]);
  return {
    headSha,
    evidence: {
      number,
      title: "chore: release v1.2.4",
      state: "MERGED",
      mergedAt: "2026-09-05T12:00:00Z",
      mergeCommit: { oid: headSha },
      headRefOid: f.headSha,
      headRefName: "chore/release-1.2.4",
      baseRefName: "main",
      statusCheckRollup: ci,
    },
  };
}

const BASE_PACKAGE = {
  name: "fixture",
  version: "1.2.3",
  type: "module",
  scripts: { test: "node --test" },
  dependencies: { leftpad: "1.0.0" },
};

const BASE_LOCK = {
  name: "fixture",
  version: "1.2.3",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "fixture",
      version: "1.2.3",
      dependencies: { leftpad: "1.0.0" },
    },
    "node_modules/leftpad": { version: "1.0.0" },
  },
};

const BASE_CHANGELOG = `# Changelog

## [1.2.3] - 2026-09-01

### Fixed

- Old fix.
`;
const OLD_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const UNKNOWN_SHA = "c".repeat(40);

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(root, name, value) {
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture({
  withLock = true,
  baseChangelog = BASE_CHANGELOG,
  changelog = null,
  managedMarker = null,
  managedMarkerContent = "{}\n",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-release-only-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release@example.test"]);
  writeJson(root, "package.json", BASE_PACKAGE);
  if (withLock) writeJson(root, "package-lock.json", BASE_LOCK);
  writeFileSync(join(root, "CHANGELOG.md"), baseChangelog);
  if (managedMarker) {
    const markerPath = join(root, managedMarker);
    mkdirSync(join(markerPath, ".."), { recursive: true });
    writeFileSync(markerPath, managedMarkerContent);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "feat: prior milestone"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", baseSha]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(root, ["switch", "-q", "-c", "chore/release-1.2.4"]);

  writeJson(root, "package.json", { ...BASE_PACKAGE, version: "1.2.4" });
  if (withLock) {
    writeJson(root, "package-lock.json", {
      ...BASE_LOCK,
      version: "1.2.4",
      packages: {
        ...BASE_LOCK.packages,
        "": { ...BASE_LOCK.packages[""], version: "1.2.4" },
      },
    });
  }
  writeFileSync(
    join(root, "CHANGELOG.md"),
    changelog ?? `# Changelog

## [1.2.4] - 2026-09-05

### Fixed

- New fix.

## [1.2.3] - 2026-09-01

### Fixed

- Old fix.
`,
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "chore: release v1.2.4"]);
  return {
    root,
    baseSha,
    headSha: git(root, ["rev-parse", "HEAD"]),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("classifica um único commit release-only limpo sobre origin/main", async () => {
  const f = releaseFixture();
  try {
    const { classifyPiReleaseOnly } = await subject();
    const result = classifyPiReleaseOnly(f.root);
    assert.deepEqual(result, {
      ok: true,
      branch: "chore/release-1.2.4",
      version: "1.2.4",
      headSha: f.headSha,
      baseSha: f.baseSha,
      baseBranch: "main",
    });
  } finally {
    f.close();
  }
});

test("classifica o commit release-only já mergeado em main pelo PR e CI exatos", async () => {
  const f = releaseFixture();
  try {
    const merged = mergeReleaseFixture(f);
    const { classifyPiPostMergeRelease } = await subject();
    assert.deepEqual(classifyPiPostMergeRelease(f.root, merged.evidence), {
      ok: true,
      phase: "post-merge",
      branch: "main",
      releaseBranch: "chore/release-1.2.4",
      releaseHeadSha: f.headSha,
      version: "1.2.4",
      tag: "v1.2.4",
      headSha: merged.headSha,
      baseSha: f.baseSha,
      baseBranch: "main",
      releaseNotes: `## [1.2.4] - 2026-09-05

### Fixed

- New fix.

`,
      prNumber: 42,
    });
  } finally {
    f.close();
  }
});

test("resolver falha localmente sem consultar o host para commit comum em main", async () => {
  const f = releaseFixture();
  try {
    git(f.root, ["switch", "-q", "main"]);
    let reads = 0;
    const { resolvePiReleaseProof } = await subject();
    const result = resolvePiReleaseProof(f.root, {
      readMergedReleaseEvidenceFn: () => {
        reads += 1;
        return null;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});

test("nega exceção manual quando o repositório é gerenciado por release-please", async () => {
  const { classifyPiReleaseOnly, classifyPiPostMergeRelease } = await subject();
  for (const [marker, content] of [
    ["release-please-config.json", "{}\n"],
    [".release-please-manifest.json", "{}\n"],
    [".github/workflows/release-please.yml", "name: release\n"],
    [".github/workflows/publish.yml", "steps:\n  - uses: googleapis/release-please-action@v4\n"],
  ]) {
    const pre = releaseFixture({ managedMarker: marker, managedMarkerContent: content });
    try {
      assert.equal(classifyPiReleaseOnly(pre.root).ok, false, marker);
    } finally {
      pre.close();
    }

    const post = releaseFixture({ managedMarker: marker, managedMarkerContent: content });
    try {
      const merged = mergeReleaseFixture(post);
      assert.equal(classifyPiPostMergeRelease(post.root, merged.evidence).ok, false, marker);
    } finally {
      post.close();
    }
  }
});

test("nega downgrade mesmo quando pacote, lock, branch e changelog concordam", async () => {
  const f = releaseFixture();
  try {
    git(f.root, ["branch", "-m", "chore/release-1.2.2"]);
    writeJson(f.root, "package.json", { ...BASE_PACKAGE, version: "1.2.2" });
    writeJson(f.root, "package-lock.json", {
      ...BASE_LOCK,
      version: "1.2.2",
      packages: {
        ...BASE_LOCK.packages,
        "": { ...BASE_LOCK.packages[""], version: "1.2.2" },
      },
    });
    writeFileSync(
      join(f.root, "CHANGELOG.md"),
      BASE_CHANGELOG.replace("## [1.2.3]", "## [1.2.2]\n\n- Downgrade.\n\n## [1.2.3]"),
    );
    git(f.root, ["add", "."]);
    git(f.root, ["commit", "-q", "--amend", "-m", "chore: release v1.2.2"]);
    const { classifyPiReleaseOnly } = await subject();
    assert.equal(classifyPiReleaseOnly(f.root).ok, false);
  } finally {
    f.close();
  }
});

test("pós-merge nega produto misturado, PR divergente e CI ausente ou vermelho", async () => {
  const { classifyPiPostMergeRelease } = await subject();

  const product = releaseFixture();
  try {
    const merged = mergeReleaseFixture(product);
    writeFileSync(join(product.root, "src.mjs"), "export const product = true;\n");
    git(product.root, ["add", "src.mjs"]);
    git(product.root, ["commit", "-q", "--amend", "--no-edit"]);
    const amended = git(product.root, ["rev-parse", "HEAD"]);
    git(product.root, ["update-ref", "refs/remotes/origin/main", amended]);
    const evidence = { ...merged.evidence, mergeCommit: { oid: amended } };
    assert.equal(classifyPiPostMergeRelease(product.root, evidence).ok, false);
  } finally {
    product.close();
  }

  for (const mutate of [
    (evidence) => ({ ...evidence, number: 99 }),
    (evidence) => ({ ...evidence, headRefName: "chore/release-1.2.5" }),
    (evidence) => ({ ...evidence, headRefOid: "abcdef0" }),
    (evidence) => {
      const { headRefOid: _headRefOid, ...withoutHead } = evidence;
      return withoutHead;
    },
    (evidence) => ({ ...evidence, mergeCommit: { oid: "f".repeat(40) } }),
    (evidence) => ({ ...evidence, statusCheckRollup: [] }),
    (evidence) => ({ ...evidence, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
  ]) {
    const f = releaseFixture();
    try {
      const merged = mergeReleaseFixture(f);
      assert.equal(classifyPiPostMergeRelease(f.root, mutate(merged.evidence)).ok, false);
    } finally {
      f.close();
    }
  }
});

test("aceita release sem package-lock quando o projeto não possui esse arquivo", async () => {
  const f = releaseFixture({ withLock: false });
  try {
    const { classifyPiReleaseOnly } = await subject();
    assert.equal(classifyPiReleaseOnly(f.root).ok, true);
  } finally {
    f.close();
  }
});

test("aceita a rotação Keep a Changelog com Unreleased vazio e conteúdo movido", async () => {
  const old = `# Changelog

## [Unreleased]

### Fixed

- New fix.

## [1.2.3] - 2026-09-01

### Fixed

- Old fix.
`;
  const current = `# Changelog

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [1.2.4] - 2026-09-05

### Fixed

- New fix.

## [1.2.3] - 2026-09-01

### Fixed

- Old fix.
`;
  const f = releaseFixture({ baseChangelog: old, changelog: current });
  try {
    const { classifyPiReleaseOnly } = await subject();
    assert.equal(classifyPiReleaseOnly(f.root).ok, true);
  } finally {
    f.close();
  }
});

test("nega código, scripts ou dependências misturados ao commit de release", async () => {
  const mutations = [
    ["src.mjs", "export const changed = true;\n"],
    ["package.json", { ...BASE_PACKAGE, version: "1.2.4", scripts: { test: "node --test", deploy: "prod" } }],
    ["package.json", { ...BASE_PACKAGE, version: "1.2.4", dependencies: { leftpad: "2.0.0" } }],
  ];
  const { classifyPiReleaseOnly } = await subject();
  for (const [name, value] of mutations) {
    const f = releaseFixture();
    try {
      typeof value === "string" ? writeFileSync(join(f.root, name), value) : writeJson(f.root, name, value);
      git(f.root, ["add", "."]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
      assert.equal(classifyPiReleaseOnly(f.root).ok, false, name);
    } finally {
      f.close();
    }
  }
});

test("nega árvore suja, histórico com múltiplos commits e parent diferente de origin/main", async () => {
  const { classifyPiReleaseOnly } = await subject();

  const dirty = releaseFixture();
  try {
    writeFileSync(join(dirty.root, "scratch.txt"), "dirty\n");
    assert.equal(classifyPiReleaseOnly(dirty.root).ok, false);
  } finally {
    dirty.close();
  }

  const multiple = releaseFixture();
  try {
    writeFileSync(join(multiple.root, "CHANGELOG.md"), `${BASE_CHANGELOG}\n<!-- second -->\n`);
    git(multiple.root, ["add", "CHANGELOG.md"]);
    git(multiple.root, ["commit", "-q", "-m", "chore: release v1.2.4"]);
    assert.equal(classifyPiReleaseOnly(multiple.root).ok, false);
  } finally {
    multiple.close();
  }

  const wrongBase = releaseFixture();
  try {
    git(wrongBase.root, ["update-ref", "refs/remotes/origin/main", wrongBase.headSha]);
    assert.equal(classifyPiReleaseOnly(wrongBase.root).ok, false);
  } finally {
    wrongBase.close();
  }
});

test("nega branch, subject, versões, JSON e changelog que não casam exatamente", async () => {
  const cases = [
    (f) => git(f.root, ["branch", "-m", "chore/release-1.2.5"]),
    (f) => git(f.root, ["commit", "-q", "--amend", "-m", "chore: release 1.2.4"]),
    (f) => {
      writeJson(f.root, "package.json", { ...BASE_PACKAGE, version: "1.2.5" });
      git(f.root, ["add", "package.json"]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
    },
    (f) => {
      writeFileSync(join(f.root, "package.json"), "{ malformed\n");
      git(f.root, ["add", "package.json"]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
    },
    (f) => {
      writeFileSync(join(f.root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.4]\n\n- New only.\n");
      git(f.root, ["add", "CHANGELOG.md"]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
    },
    (f) => {
      writeFileSync(
        join(f.root, "CHANGELOG.md"),
        `${BASE_CHANGELOG}## [1.2.4] - 2026-09-05\n\n- Appended out of order.\n`,
      );
      git(f.root, ["add", "CHANGELOG.md"]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
    },
    (f) => {
      const lock = structuredClone(BASE_LOCK);
      lock.version = "1.2.4";
      lock.packages[""].version = "1.2.4";
      lock.packages[""].dependencies.leftpad = "2.0.0";
      writeJson(f.root, "package-lock.json", lock);
      git(f.root, ["add", "package-lock.json"]);
      git(f.root, ["commit", "-q", "--amend", "--no-edit"]);
    },
  ];
  const { classifyPiReleaseOnly } = await subject();
  for (const mutate of cases) {
    const f = releaseFixture();
    try {
      mutate(f);
      assert.equal(classifyPiReleaseOnly(f.root).ok, false);
    } finally {
      f.close();
    }
  }
});

test("escopa apenas obrigações com absolvição antiga comprovadamente fora da ancestry", async () => {
  const { scopePiReleaseOnlyTaskState } = await subject();
  const state = {
    classified: true,
    mode: "FULL",
    feature_id: "feat",
    regate_pending: ["feat/old", "feat/current", "feat/unknown"],
    regate_passed: [`feat/old@${OLD_SHA}`, `feat/current@${HEAD_SHA}`, `feat/unknown@${UNKNOWN_SHA}`],
    hand_finished: ["feat/old", "feat/current"],
    capture_verified: [`feat/old@${OLD_SHA}`, `feat/current@${HEAD_SHA}`],
  };
  const result = scopePiReleaseOnlyTaskState(state, (sha) =>
    sha === OLD_SHA ? false : sha === HEAD_SHA ? true : null,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.regate_pending, ["feat/current", "feat/unknown"]);
  assert.deepEqual(result.state.hand_finished, ["feat/current"]);
  assert.deepEqual(result.ignoredTasks, ["feat/old"]);
  assert.deepEqual(state.regate_pending, ["feat/old", "feat/current", "feat/unknown"]);
});

test("não escopa marker malformado nem obrigação sem SHA antigo verificável", async () => {
  const { scopePiReleaseOnlyTaskState } = await subject();
  assert.equal(scopePiReleaseOnlyTaskState({ regate_pending: "feat/t" }, () => false).ok, false);
  const current = scopePiReleaseOnlyTaskState(
    { regate_pending: ["feat/t"], regate_passed: [`feat/t@${UNKNOWN_SHA}`] },
    () => null,
  );
  assert.equal(current.ok, true);
  assert.deepEqual(current.state.regate_pending, ["feat/t"]);
  assert.deepEqual(current.ignoredTasks, []);

  const forgedSha = scopePiReleaseOnlyTaskState(
    { regate_pending: ["feat/t"], regate_passed: ["feat/t@--forged-revision"] },
    () => false,
  );
  assert.equal(forgedSha.ok, true);
  assert.deepEqual(forgedSha.state.regate_pending, ["feat/t"]);
  assert.deepEqual(forgedSha.ignoredTasks, []);
});

test("vincula a exceção de merge ao HEAD, branch e base exatos do PR", async () => {
  const { piReleaseMergeMatchesProof } = await subject();
  const proof = {
    ok: true,
    branch: "chore/release-1.2.4",
    headSha: "head",
    baseSha: "base",
    baseBranch: "main",
  };
  assert.equal(
    piReleaseMergeMatchesProof(proof, {
      headRefOid: "head",
      headRefName: "chore/release-1.2.4",
      baseRefName: "main",
      baseRefOid: "base",
    }),
    true,
  );
  for (const evidence of [
    null,
    { headRefOid: "other", headRefName: proof.branch, baseRefName: "main", baseRefOid: "base" },
    { headRefOid: "head", headRefName: "feat/other", baseRefName: "main", baseRefOid: "base" },
    { headRefOid: "head", headRefName: proof.branch, baseRefName: "develop", baseRefOid: "base" },
    { headRefOid: "head", headRefName: proof.branch, baseRefName: "main", baseRefOid: "advanced-base" },
  ]) {
    assert.equal(piReleaseMergeMatchesProof(proof, evidence), false);
  }
});
