/**
 * @description Pure attempt-epoch helpers for the append-only observability feed.
 * A retry appends `attempt-started`; producers use only the suffix after that boundary
 * for dedupe, while the drain keeps the complete audit log and its cursor untouched.
 */

/**
 * @param {unknown[]} events
 * @returns {object[]}
 */
export function currentAttemptEvents(events) {
  const all = Array.isArray(events) ? events : [];
  let boundary = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i] && typeof all[i] === "object" && all[i].type === "attempt-started") {
      boundary = i;
      break;
    }
  }
  return boundary === -1 ? all : all.slice(boundary + 1);
}

/**
 * @param {unknown[]} events
 * @returns {number}
 */
export function nextAttemptNumber(events) {
  const all = Array.isArray(events) ? events : [];
  let highest = 1;
  for (const event of all) {
    if (event?.type !== "attempt-started") continue;
    const n = Number(event.attempt);
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return highest + 1;
}
