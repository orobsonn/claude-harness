import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTING_PATH = fileURLToPath(new URL("./harness.routing.json", import.meta.url));
const COMPLEXITIES = new Set(["low", "medium", "high", "critical"]);

function readRouting(readFile = readFileSync) {
  return JSON.parse(readFile(ROUTING_PATH, "utf8"));
}

/** The routing contract's historical strong alias resolves to the native dispatch model id. */
function dispatchModel(model) {
  return model === "gpt-5.6" ? "gpt-5.6-sol" : model;
}

export function resolveRoute(role, complexity, readFile = readFileSync) {
  const routing = readRouting(readFile);
  const roleConfig = routing.roles?.[role];
  if (!roleConfig) throw new Error(`unsupported role: ${role}`);
  if (!COMPLEXITIES.has(complexity)) throw new Error(`unsupported complexity: ${complexity}`);
  const [model, reasoning_effort] = roleConfig.routes?.[complexity] ?? [];
  if (!model || !reasoning_effort || !roleConfig.sandbox_mode) {
    throw new Error(`incomplete route: ${role}/${complexity}`);
  }
  return { model: dispatchModel(model), reasoning_effort, sandbox_mode: roleConfig.sandbox_mode };
}

export function parseRouteArgs(argv) {
  const role = argv.indexOf("--role");
  const complexity = argv.indexOf("--complexity");
  if (role === -1 || complexity === -1 || !argv[role + 1] || !argv[complexity + 1]) {
    throw new Error("usage: model-routing.mjs --role <role> --complexity <low|medium|high|critical>");
  }
  return { role: argv[role + 1], complexity: argv[complexity + 1] };
}

export { COMPLEXITIES };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { role, complexity } = parseRouteArgs(process.argv);
    process.stdout.write(`${JSON.stringify(resolveRoute(role, complexity))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
