import { resolveRoute } from "../model-routing.mjs";

const TIERS = new Set(["QUICK", "LIGHT", "FULL"]);
const REQUIRED_TASK_FIELDS = ["id", "files", "red_test", "minimal_implementation", "green_test", "verification", "route"];

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Validate an explicit delivery-plan artifact without persisting or advancing any
 * workflow state. It ports the high-leverage plan invariants, not a second engine.
 */
export function validateDeliveryPlan(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["plan must be an object"] };
  if (!TIERS.has(value.tier)) errors.push("tier must be QUICK, LIGHT, or FULL");
  if (!Array.isArray(value.tasks)) errors.push("tasks must be an array");
  else if (value.tier === "QUICK" && value.tasks.length > 0) errors.push("QUICK must not declare a multi-task delivery plan");
  else if (value.tier !== "QUICK" && value.tasks.length === 0) errors.push(`${value.tier} requires at least one task`);
  else for (const [index, task] of value.tasks.entries()) {
    if (!task || typeof task !== "object" || Array.isArray(task)) { errors.push(`task ${index} must be an object`); continue; }
    for (const field of REQUIRED_TASK_FIELDS) {
      if (field === "files") {
        if (!Array.isArray(task.files) || task.files.length === 0 || !task.files.every(nonEmpty)) errors.push(`task ${index}.files must be non-empty paths`);
      } else if (field === "route") {
        if (!task.route || typeof task.route !== "object" || !nonEmpty(task.route.role) || !nonEmpty(task.route.complexity)) errors.push(`task ${index}.route is required`);
        else {
          try { resolveRoute(task.route.role, task.route.complexity); } catch { errors.push(`task ${index} has unsupported route ${task.route.role}/${task.route.complexity}`); }
        }
      } else if (!nonEmpty(task[field])) errors.push(`task ${index}.${field} is required`);
    }
  }
  return { ok: errors.length === 0, errors };
}
