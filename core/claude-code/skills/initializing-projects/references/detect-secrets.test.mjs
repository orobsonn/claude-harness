#!/usr/bin/env node
/**
 * @description Tests for detect-secrets.mjs — verifies secret name detection from
 * .dev.vars.example, .env.example, and wrangler.jsonc; enforces security constraints
 * (names only, no values, commented lines skipped, crafted JSONC no-throw).
 *
 * Usage:
 *   node --test detect-secrets.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRequiredSecrets } from "./detect-secrets.mjs";

// --- helpers ---

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "detect-secrets-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// --- locked tests (must not be weakened) ---

test("locked-1: .dev.vars.example with OLLAMA_HAND_TOKEN= → secrets includes it", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, ".dev.vars.example"), "OLLAMA_HAND_TOKEN=\n");
    const { secrets } = detectRequiredSecrets(dir);
    assert.ok(
      secrets.includes("OLLAMA_HAND_TOKEN"),
      `Expected secrets to include "OLLAMA_HAND_TOKEN", got: ${JSON.stringify(secrets)}`
    );
  } finally {
    cleanup(dir);
  }
});

test("locked-2: secrets [FOO, BAR] → setupGuide contains gh secret set FOO and BAR", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, ".dev.vars.example"), "FOO=\nBAR=\n");
    const { secrets, setupGuide } = detectRequiredSecrets(dir);
    assert.ok(
      secrets.includes("FOO"),
      `Expected secrets to include "FOO", got: ${JSON.stringify(secrets)}`
    );
    assert.ok(
      secrets.includes("BAR"),
      `Expected secrets to include "BAR", got: ${JSON.stringify(secrets)}`
    );
    assert.ok(
      setupGuide.includes("gh secret set FOO"),
      `Expected setupGuide to include "gh secret set FOO", got: ${setupGuide}`
    );
    assert.ok(
      setupGuide.includes("gh secret set BAR"),
      `Expected setupGuide to include "gh secret set BAR", got: ${setupGuide}`
    );
  } finally {
    cleanup(dir);
  }
});

test("locked-3: no example/config files → secrets === [] and setupGuide === ''", async () => {
  const dir = makeTempDir();
  try {
    const { secrets, setupGuide } = detectRequiredSecrets(dir);
    assert.deepStrictEqual(secrets, []);
    assert.strictEqual(setupGuide, "");
  } finally {
    cleanup(dir);
  }
});

test("locked-4: wrangler.jsonc with vars block { API_BASE: 'x' } → secrets includes API_BASE", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      `{
  // wrangler config
  "name": "my-worker",
  "vars": {
    "API_BASE": "x"
  }
}`
    );
    const { secrets } = detectRequiredSecrets(dir);
    assert.ok(
      secrets.includes("API_BASE"),
      `Expected secrets to include "API_BASE", got: ${JSON.stringify(secrets)}`
    );
  } finally {
    cleanup(dir);
  }
});

// --- security constraint tests ---

test("security: no value leaked — FOO=somevalue in .dev.vars.example → only name emitted", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, ".dev.vars.example"), "FOO=somevalue\n");
    const { secrets, setupGuide } = detectRequiredSecrets(dir);
    assert.ok(
      secrets.includes("FOO"),
      `Expected secrets to include "FOO", got: ${JSON.stringify(secrets)}`
    );
    assert.ok(
      !secrets.includes("somevalue"),
      `setupGuide must not contain the value "somevalue", got: ${JSON.stringify(secrets)}`
    );
    assert.ok(
      !setupGuide.includes("somevalue"),
      `setupGuide must not contain the value "somevalue", got: ${setupGuide}`
    );
  } finally {
    cleanup(dir);
  }
});

test("security: commented line in .dev.vars.example is ignored", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, ".dev.vars.example"),
      "# COMMENTED_SECRET=ignored\nREAL_SECRET=\n"
    );
    const { secrets } = detectRequiredSecrets(dir);
    assert.ok(
      !secrets.includes("COMMENTED_SECRET"),
      `Commented secret must not appear, got: ${JSON.stringify(secrets)}`
    );
    assert.ok(
      secrets.includes("REAL_SECRET"),
      `REAL_SECRET should appear, got: ${JSON.stringify(secrets)}`
    );
  } finally {
    cleanup(dir);
  }
});

test("security: crafted/malformed wrangler.jsonc must not throw or inject", async () => {
  const dir = makeTempDir();
  try {
    // Crafted JSONC with nested evil content but valid enough structure
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      `{
  // injection attempt: __proto__, constructor, eval-like keys
  "vars": {
    "__proto__": "evil",
    "constructor": "evil",
    "SAFE_KEY": "value"
  },
  "extra_junk": }{broken{{`
    );
    // Must not throw — return whatever it can parse
    let result;
    assert.doesNotThrow(() => {
      result = detectRequiredSecrets(dir);
    });
    // __proto__ and constructor must not appear in secrets
    assert.ok(
      !result.secrets.includes("__proto__"),
      `__proto__ must not appear in secrets, got: ${JSON.stringify(result.secrets)}`
    );
    assert.ok(
      !result.secrets.includes("constructor"),
      `constructor must not appear in secrets, got: ${JSON.stringify(result.secrets)}`
    );
  } finally {
    cleanup(dir);
  }
});

test("security: .env.example with values → only names in secrets", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, ".env.example"),
      "DATABASE_URL=postgres://user:password@localhost/db\nSECRET_KEY=abc123\n"
    );
    const { secrets, setupGuide } = detectRequiredSecrets(dir);
    assert.ok(secrets.includes("DATABASE_URL"), `Expected DATABASE_URL in secrets`);
    assert.ok(secrets.includes("SECRET_KEY"), `Expected SECRET_KEY in secrets`);
    assert.ok(!setupGuide.includes("postgres://"), `Must not leak DB URL`);
    assert.ok(!setupGuide.includes("abc123"), `Must not leak secret value`);
  } finally {
    cleanup(dir);
  }
});

test("dedup: same secret in multiple source files appears once", async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, ".dev.vars.example"), "SHARED=\n");
    writeFileSync(join(dir, ".env.example"), "SHARED=\n");
    const { secrets } = detectRequiredSecrets(dir);
    const count = secrets.filter((s) => s === "SHARED").length;
    assert.strictEqual(count, 1, `Expected SHARED to appear exactly once, got: ${count}`);
  } finally {
    cleanup(dir);
  }
});
