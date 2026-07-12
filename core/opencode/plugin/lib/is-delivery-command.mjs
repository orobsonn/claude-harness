/**
 * @description Pure delivery-command detector (CC isDeliveryCommand port for OC bash gate).
 * Never throws.
 */

/**
 * @description True when command is git push / gh pr create|merge (incl. git global flags + && composites).
 * @param {unknown} command
 * @returns {boolean}
 */
export function isDeliveryCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  // Split on shell list operators so `echo x && gh pr create` still matches
  const parts = command.split(/(?:&&|\|\||;)/);
  for (const part of parts) {
    const c = part.trim();
    if (!c) continue;
    if (
      /\bgit\s+(?:(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+)\s+)*push\b/.test(
        c,
      )
    ) {
      return true;
    }
    if (/\bgh\s+pr\s+create\b/.test(c)) return true;
    if (/\bgh\s+pr\s+merge\b/.test(c)) return true;
  }
  return false;
}
