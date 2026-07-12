import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/npm-publish.yml');

describe('npm-publish workflow contract', () => {
  const content = readFileSync(WORKFLOW_PATH, 'utf8');

  it('triggers on release published only', () => {
    assert.ok(content.includes('on:'));
    assert.ok(content.includes('release:'));
    assert.ok(content.includes('types: [published]'));
  });

  it('has version guard step comparing package.json to tag', () => {
    assert.ok(content.includes('Verify version matches release tag'));
    assert.ok(content.includes('PKG_VERSION=$(node -p "require(\'./package.json\').version")'));
    assert.ok(content.includes('TAG_VERSION=${GITHUB_REF#refs/tags/v}'));
  });

  it('uses NODE_AUTH_TOKEN from secrets.NPM_TOKEN, no literal token', () => {
    assert.ok(content.includes('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'));
    assert.ok(!content.includes('NPM_TOKEN:') || content.includes('secrets.NPM_TOKEN'));
    assert.ok(!/NODE_AUTH_TOKEN:\s*['"]?[a-z0-9_-]{10,}/i.test(content));
  });
});
