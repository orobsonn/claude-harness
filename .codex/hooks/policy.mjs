import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const FORBIDDEN_COMMANDS = [
  [/\bgit(?:\s+\S+)*\s+push\b[\s\S]*(?:--force(?:=|\s|$)|-f(?:\s|$))/, "Force push is blocked; use --force-with-lease only after review."],
  [/\bgit(?:\s+\S+)*\s+reset\b[\s\S]*--hard(?:\s|$)/, "Hard reset is blocked because it destroys local work."],
  [/\bgit(?:\s+\S+)*\s+clean\b[\s\S]*-[^\s]*f/, "Forced git clean is blocked because it destroys untracked work."],
  [/(?:^|[;&|]\s*)(?:(?:(?:\/usr\/bin\/)?env|command)\s+)*(?:(?:npx|bunx|pnpm(?:\s+--[\w-]+(?:=\S+)?)*\s+(?:exec|dlx)|yarn\s+dlx|bun\s+x|npm\s+exec)\b(?:\s+(?!wrangler\b)\S+)*\s+|\.\/node_modules\/\.bin\/)?wrangler\s+(?:deploy|versions|secret|r2)\b/, "Remote Wrangler operation is outside the default delivery lane."],
  [/(?:^|[;&|]\s*)(?:(?:(?:\/usr\/bin\/)?env|command)\s+)*(?:(?:npx|bunx|pnpm(?:\s+--[\w-]+(?:=\S+)?)*\s+(?:exec|dlx)|yarn\s+dlx|bun\s+x|npm\s+exec)\b(?:\s+(?!wrangler\b)\S+)*\s+|\.\/node_modules\/\.bin\/)?wrangler\s+d1\s+execute\b[\s\S]*--remote(?:\s|$)/, "Remote Wrangler D1 operation is outside the default delivery lane."],
  [/(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?:\s|$)/, "Deployment is outside the default delivery lane."],
];

const LAVISH_SEGMENTS = /[;&|\n]+/;
const LAVISH_CLI = /\blavish-axi(?:@[\w.-]+)?\b/i;
const SENSITIVE_PATH = /(?:^|[\s"'`/])(?:~\/)?(?:\.env(?:\.[A-Za-z0-9_-]+)?(?=\s|$|\/|[$({])|\.dev\.vars(?=\s|$|\/|[$({])|\.ssh(?:\/|\s|$)|\.aws(?:\/|\s|$))/;
const SENSITIVE_SHELL_FORM = /\$\(\s*(?:printf|echo)\s+['"]?\.env\b|(?:^|\s)\.e\?\?(?=\s|$)|(?:^|\s)\.\{en\}v(?=\s|$)/;
const SHELL_READER = /\b(?:cat|rg|grep|sed|awk|head|tail|less|more|rtk\s+read)\b/;
const DYNAMIC_READER_PATH = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z]\[[^\]]+\][A-Za-z]/;

function denyForLavish(command) {
  if (typeof command !== "string") return null;
  for (const segment of command.split(LAVISH_SEGMENTS)) {
    if (!LAVISH_CLI.test(segment)) continue;
    if (/\bshare\b/i.test(segment)) {
      return "lavish-axi share is blocked because it can publish an artifact to a third-party host.";
    }
    if (/\bsetup\s+hooks\b/i.test(segment)) {
      return "lavish-axi setup hooks is blocked because it can install competing project hooks.";
    }
  }
  return null;
}

export function protectablePath(path) {
  return /(?:^|[/\s"\x27`])\.(?:codex|agents)(?:[/\s"\x27`]|$)/.test(String(path));
}

function preDecision(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function permissionDecision(reason) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
}

function denyForCommand(command) {
  if (SENSITIVE_PATH.test(command) || SENSITIVE_SHELL_FORM.test(command)) return "Secret-bearing paths are blocked from shell access by the delivery harness.";
  if (SHELL_READER.test(command) && DYNAMIC_READER_PATH.test(command)) return "Dynamic paths are blocked for shell readers because they can conceal secret-bearing files.";
  return denyForLavish(command) ?? FORBIDDEN_COMMANDS.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}

function mutatesProtectedPath(tool, command) {
  if (!protectablePath(command)) return false;
  if (tool === "apply_patch") return true;
  if (tool !== "Bash") return false;
  return /\b(?:rm|mv|cp|install|touch|mkdir|chmod|chown|truncate|tee|sed|perl)\b|(?:^|[^<])>{1,2}/.test(command);
}

function safeId(value) {
  const id = String(value ?? "");
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

function recordAudit(event, auditDir = join(process.cwd(), ".codex", "audit")) {
  if (!auditDir) return false;
  const sessionId = safeId(event?.session_id);
  const toolUseId = safeId(event?.tool_use_id);
  if (!sessionId || !toolUseId || typeof event?.tool_name !== "string") return false;
  const root = resolve(auditDir);
  const file = join(root, `${sessionId}-${toolUseId}.json`);
  const receipt = JSON.stringify({
    event: "PostToolUse",
    tool: event.tool_name,
    session_id: sessionId,
    tool_use_id: toolUseId,
  });
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(file, receipt, { encoding: "utf8", flag: "wx", flush: true });
    return true;
  } catch {
    return false;
  }
}

export function evaluateHook(event, { auditDir } = {}) {
  const name = event?.hook_event_name;
  const tool = event?.tool_name;
  const command = event?.tool_input?.command;
  if (name === "PostToolUse") {
    recordAudit(event, auditDir);
    // Post-tool output is deliberately empty: a receipt is local evidence, not model context.
    return {};
  }
  if (!["PreToolUse", "PermissionRequest"].includes(name)) return {};
  const reason = typeof command === "string"
    ? (mutatesProtectedPath(tool, command) ? "Harness-owned paths are protected from direct tool mutation." : denyForCommand(command))
    : (tool === "Bash" || tool === "apply_patch" ? "Malformed tool input is denied before execution." : null);
  if (!reason) return {};
  return name === "PreToolUse" ? preDecision(reason) : permissionDecision(reason);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let payload;
  try { payload = JSON.parse(await readStdin()); } catch {
    process.stdout.write(JSON.stringify(preDecision("Malformed hook payload is denied.")) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(evaluateHook(payload)) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
