/**
 * @description Plain importable TRACK-row parser shared by oc-automerge-gate's consistency locked
 * test (LT5) and cutover-preflight. Extracted out of scripts/cutover-preflight.test.mjs so importing
 * it does NOT drag the whole preflight suite in as a side-effect, and WIDENED to match BOTH TRACK
 * table shapes:
 *   - 6-column Phase-1/Phase-2: `| ID | Item | Contract docs | Status | Date | Notes |`
 *   - 5-column Phase-0/Phase-2b: `| ID | Item | Status | Date | Notes |`
 * T15 lives in the 5-column Phase-2b table, so the prior 6-column-only parser returned null for it.
 * The 6-column form is tried FIRST so a 6-column row's `Contract docs` column is never misread as
 * `Status` (e.g. T14's `09` would otherwise parse as the status). Already-passing 6-column rows
 * (T10/T11/T14/...) parse identically to the prior parser.
 * @param {string} trackText
 * @param {string} id e.g. "T10", "T12", "T15"
 * @returns {{ id: string, status: string, date: string, notes: string } | null}
 */
export function parseTrackRow(trackText, id) {
  const lines = trackText.split("\n");
  // 6-column: | ID | Item | Contract docs | Status | Date | Notes |
  const re6 = new RegExp(
    `^\\|\\s*${id}\\s*\\|[^|]*\\|[^|]*\\|\\s*(\\w+)\\s*\\|\\s*([^|]*)\\|\\s*(.*)\\|\\s*$`
  );
  // 5-column: | ID | Item | Status | Date | Notes |
  const re5 = new RegExp(
    `^\\|\\s*${id}\\s*\\|[^|]*\\|\\s*(\\w+)\\s*\\|\\s*([^|]*)\\|\\s*(.*)\\|\\s*$`
  );
  for (const line of lines) {
    const m6 = line.match(re6);
    if (m6) {
      return { id, status: m6[1].trim(), date: m6[2].trim(), notes: m6[3].trim() };
    }
    const m5 = line.match(re5);
    if (m5) {
      return { id, status: m5[1].trim(), date: m5[2].trim(), notes: m5[3].trim() };
    }
  }
  return null;
}