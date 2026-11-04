import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('shipper PR-body example preserves Markdown without executing embedded commands', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipper-literal-body-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = fs.readFileSync(new URL('./harness-shipper.md', import.meta.url), 'utf8');
  const template = prompt.match(/```bash\n(cat > \/tmp\/harness-pr-body\.md[\s\S]*?)\n```/)?.[1];
  assert.ok(template, 'shipping must supply its literal-file preparation example');
  const body = 'Closes #256\n\nValidação: `touch unexpected-backticks` e $(touch unexpected-substitution).\nUTF-8: revisão aprovada.\n';
  const command = template.replace('/tmp/harness-pr-body.md', 'pr-body.md')
    .replace('CONTEUDO_LITERAL_DO_PR\n', body);
  const result = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'pr-body.md'), 'utf8'), body);
  assert.deepEqual(fs.readdirSync(root), ['pr-body.md']);
});
