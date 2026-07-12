/** @description Locked tests for OC bash delivery + forge decide (session-275 class). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideBashDelivery,
  decideBashForge,
  firstArgvBasename,
} from "./bash-decide.mjs";

const SID = "ses_test_delivery_1";

test("empty gate + gh pr → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    sessionId: SID,
  });
  assert.equal(d.decision, "deny");
});

test("unreadable gate load → deny", () => {
  const d = decideBashDelivery({
    command: "git push",
    sessionId: SID,
    gateStateLoadOk: false,
  });
  assert.equal(d.decision, "deny");
});

test("QUICK+classified → allow", () => {
  const d = decideBashDelivery({
    command: "git push -u origin h",
    sessionId: SID,
    gateState: { mode: "QUICK", classified: true },
  });
  assert.equal(d.decision, "allow");
});

test("LIGHT brainstorm+adversary → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    sessionId: SID,
    gateState: {
      mode: "LIGHT",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
    },
  });
  assert.equal(d.decision, "allow");
});

test("LIGHT missing brainstormed → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: {
      mode: "LIGHT",
      classified: true,
      adversary_fired: true,
    },
  });
  assert.equal(d.decision, "deny");
});

test("no-ceremony → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: { mode: "no-ceremony", classified: true },
  });
  assert.equal(d.decision, "deny");
});

test("FULL without dual → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    sessionId: SID,
    gateState: {
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
    },
  });
  assert.equal(d.decision, "deny");
});

test("FULL + dual both → allow", () => {
  const d = decideBashDelivery({
    command: "git push",
    sessionId: SID,
    gateState: {
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      dual_status: "both",
    },
  });
  assert.equal(d.decision, "allow");
});

test("forge cat gate-state → deny", () => {
  const d = decideBashForge({
    command: "cat > .opencode/plans/.state/ses_x/gate-state.json <<EOF\n{}\nEOF",
  });
  assert.equal(d.decision, "deny");
});

test("forge triage.json → deny", () => {
  const d = decideBashForge({
    command: "tee .opencode/plans/.state/s/triage.json < /tmp/x",
  });
  assert.equal(d.decision, "deny");
});

test("forge execution-plan.json → deny", () => {
  const d = decideBashForge({
    command: "cat > .opencode/plans/feat/execution-plan.json <<EOF\n{}\nEOF",
  });
  assert.equal(d.decision, "deny");
});

test("mark-gate allowlist basename → allow forge path", () => {
  assert.equal(firstArgvBasename("node core/opencode/plugin/lib/mark-gate.mjs stamp"), "mark-gate");
  const d = decideBashForge({
    command:
      "node core/opencode/plugin/lib/mark-gate.mjs stamp --session ses_x > .opencode/plans/.state/ses_x/gate-state.json",
  });
  assert.equal(d.decision, "allow");
});

test("dual-merge basename NOT allowlisted", () => {
  assert.equal(firstArgvBasename("node dual-merge.mjs"), "dual-merge");
  const d = decideBashForge({
    command: "node dual-merge.mjs > .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("missing sessionId + delivery → deny", () => {
  const d = decideBashDelivery({
    command: "gh pr create",
    gateState: { mode: "QUICK", classified: true },
    sessionId: null,
  });
  assert.equal(d.decision, "deny");
});

test("forge cp into gate-state.json → deny (no > required)", () => {
  const d = decideBashForge({
    command: "cp /tmp/x .opencode/plans/.state/s/gate-state.json",
  });
  assert.equal(d.decision, "deny");
});

test("forge node -e writeFileSync gate-state → deny", () => {
  const d = decideBashForge({
    command:
      "node -e \"fs.writeFileSync('.opencode/plans/.state/s/gate-state.json','{}')\"",
  });
  assert.equal(d.decision, "deny");
});

test("forge mv/rsync oracle paths → deny", () => {
  assert.equal(
    decideBashForge({
      command: "mv /tmp/x .opencode/plans/.state/s/triage.json",
    }).decision,
    "deny",
  );
  assert.equal(
    decideBashForge({
      command: "rsync /tmp/x .opencode/plans/feat/execution-plan.json",
    }).decision,
    "deny",
  );
});

test("oracle path without allowlist basename → deny even ls of .state", () => {
  // Fail-closed ship wall: any mention of oracle path + non-allowlisted basename
  const d = decideBashForge({
    command: "ls .opencode/plans/.state",
  });
  assert.equal(d.decision, "deny");
});

test("non-oracle path → allow forge check", () => {
  const d = decideBashForge({ command: "cp /tmp/a /tmp/b" });
  assert.equal(d.decision, "allow");
});
