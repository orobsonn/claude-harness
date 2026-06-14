import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const settingsPath = resolve("core/settings.json");

test("core/settings.json is valid JSON", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);
  ok(settings, "settings parsed successfully");
});

test("hooks.PreToolUse has Agent matcher with entry-gate.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PreToolUse, "hooks.PreToolUse exists");
  ok(Array.isArray(settings.hooks.PreToolUse), "PreToolUse is an array");

  const agentHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Agent"
  );
  ok(agentHook, "PreToolUse Agent matcher found");
  ok(
    agentHook.hooks &&
      agentHook.hooks[0] &&
      agentHook.hooks[0].command &&
      agentHook.hooks[0].command.includes("entry-gate.mjs"),
    "Agent hook command contains entry-gate.mjs"
  );
  ok(
    agentHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("hooks.PostToolUse has Bash matcher with stamp-triage.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PostToolUse, "hooks.PostToolUse exists");
  ok(Array.isArray(settings.hooks.PostToolUse), "PostToolUse is an array");

  const bashHook = settings.hooks.PostToolUse.find(
    (h) => h.matcher === "Bash"
  );
  ok(bashHook, "PostToolUse Bash matcher found");
  ok(
    bashHook.hooks &&
      bashHook.hooks[0] &&
      bashHook.hooks[0].command &&
      bashHook.hooks[0].command.includes("stamp-triage.mjs"),
    "Bash hook command contains stamp-triage.mjs"
  );
  ok(
    bashHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("hooks.SessionStart has compact and startup matchers with reinject-state.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.SessionStart, "hooks.SessionStart exists");
  ok(Array.isArray(settings.hooks.SessionStart), "SessionStart is an array");

  const compactHook = settings.hooks.SessionStart.find(
    (h) => h.matcher === "compact"
  );
  ok(compactHook, "SessionStart compact matcher found");
  ok(
    compactHook.hooks &&
      compactHook.hooks[0] &&
      compactHook.hooks[0].command &&
      compactHook.hooks[0].command.includes("reinject-state.mjs"),
    "compact hook command contains reinject-state.mjs"
  );
  ok(
    compactHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );

  const startupHook = settings.hooks.SessionStart.find(
    (h) => h.matcher === "startup"
  );
  ok(startupHook, "SessionStart startup matcher found");
  ok(
    startupHook.hooks &&
      startupHook.hooks[0] &&
      startupHook.hooks[0].command &&
      startupHook.hooks[0].command.includes("reinject-state.mjs"),
    "startup hook command contains reinject-state.mjs"
  );
  ok(
    startupHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("NO Skill matcher in PreToolUse and exactly 6 hooks total", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.hooks, "hooks object exists");
  ok(settings.hooks.PreToolUse, "PreToolUse exists");

  const skillMatcher = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Skill"
  );
  strictEqual(skillMatcher, undefined, "Skill matcher should not exist");

  let totalHooks = 0;
  if (settings.hooks.PreToolUse) {
    totalHooks += settings.hooks.PreToolUse.length;
  }
  if (settings.hooks.PostToolUse) {
    totalHooks += settings.hooks.PostToolUse.length;
  }
  if (settings.hooks.SessionStart) {
    totalHooks += settings.hooks.SessionStart.length;
  }

  strictEqual(totalHooks, 6, "exactly 6 hooks should be wired (Agent + Bash + Write|Edit for PreToolUse, Bash for PostToolUse, compact + startup for SessionStart)");
});

test("hooks.PreToolUse has Bash matcher with entry-gate.mjs command", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  const bashHook = settings.hooks.PreToolUse.find(
    (h) => h.matcher === "Bash"
  );
  ok(bashHook, "PreToolUse Bash matcher found");
  ok(
    bashHook.hooks &&
      bashHook.hooks[0] &&
      bashHook.hooks[0].command &&
      bashHook.hooks[0].command.includes("entry-gate.mjs"),
    "Bash hook command contains entry-gate.mjs"
  );
  ok(
    bashHook.hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
    "command uses ${CLAUDE_PROJECT_DIR} variable"
  );
});

test("permissions baseline preserved and unchanged", () => {
  const content = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(content);

  ok(settings.permissions, "permissions object exists");
  ok(Array.isArray(settings.permissions.allow), "permissions.allow is array");
  ok(Array.isArray(settings.permissions.deny), "permissions.deny is array");

  ok(settings.permissions.allow.length > 0, "allow list is not empty");
  ok(settings.permissions.deny.length > 0, "deny list is not empty");

  ok(
    settings.permissions.allow.includes("Edit"),
    "Edit permission preserved"
  );
  ok(
    settings.permissions.allow.includes("Write"),
    "Write permission preserved"
  );
  ok(
    settings.permissions.deny.includes("Bash(git reset --hard:*)"),
    "deny list preserved"
  );

  ok(
    settings.autoMemoryDirectory === ".claude/memory",
    "autoMemoryDirectory preserved"
  );
});
