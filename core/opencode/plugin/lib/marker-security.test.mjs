/** @description Separate-process regression for the explicit marker authority boundary. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const authorityPath = path.join(here, "..", "marker-authority.ts");

// #475: there is no dedicated privileged shell CLI after removing mark-gate.mjs. That reduces the
// supported workflow surface; it is not OS isolation. A same-user process can import and instantiate
// marker-authority.ts, then run its own matching before/execute pair. Such a process, direct state
// writes, and a compromised host/plugin are outside the boundary. Within one authority instance,
// direct execute, cloned args, and replay without that instance's before authorization still fail.
// This test makes the accepted same-user residual explicit instead of claiming imports are blocked.
test("a same-user process can import and instantiate its own marker authority (#475)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-import-"));
  try {
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses-a", "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const bytes = '{\n  "session_id": "ses-a",\n  "feature_id": "feature-a"\n}\n';
    fs.writeFileSync(statePath, bytes);
    const stub = `
      const schemaValue = { describe() { return this }, optional() { return this } };
      export const tool = (definition) => definition;
      tool.schema = { string() { return Object.create(schemaValue) } };
    `;
    const script = `
      const { registerHooks } = await import("node:module");
      const stub = ${JSON.stringify("__STUB__")};
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@opencode-ai/plugin/tool") {
          return { url: \`data:text/javascript,\${encodeURIComponent(stub)}\`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      } });
      const { default: authority } = await import(${JSON.stringify(pathToFileURL(authorityPath).href)});
      const hooks = await authority({ directory: process.argv[1], worktree: process.argv[1] });
      const args = { action: "brainstormed" };
      await hooks["tool.execute.before"](
        { tool: "mark", sessionID: "ses-a", callID: "same-user-call" },
        { args },
      );
      const result = await hooks.tool.mark.execute(args, {
        sessionID: "ses-a", callID: "same-user-call", messageID: "same-user-message",
        agent: "build", directory: process.argv[1], worktree: process.argv[1],
      });
      if (!result.metadata.ok) process.exit(2);
    `.replace(JSON.stringify("__STUB__"), JSON.stringify(stub));
    const attempted = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
      encoding: "utf8",
    });
    assert.equal(attempted.status, 0, attempted.stderr || attempted.stdout);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.brainstormed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
