import assert from "node:assert/strict";
import test from "node:test";

import { executeControlAction, runSilentSupervisorTick } from "./control-plane-tools.ts";

const notification = {
  kind: "event",
  type: "decision.opened",
  event_id: "decision-one-r1",
  sequence: 2,
  project_id: "project-one",
  delivery_id: "delivery-one",
  issue: { number: 1, title: "One" },
  generation: 1,
};

test("silent supervisor wakes the agent from a host event without granting operator authority", async () => {
  const sent = [];
  const acknowledged = [];
  const pi = { async sendMessage(message, options) { sent.push({ message, options }); } };
  const control = {
    async nextNotification() { return notification; },
    async acknowledgeNotification(value) { acknowledged.push(value); },
  };
  const result = await runSilentSupervisorTick(pi, control, { isIdle: () => true });
  assert.equal(result.outcome, "notified");
  assert.equal(sent[0].options.triggerTurn, true);
  const content = JSON.parse(sent[0].message.content);
  assert.equal(content.grants_operator_authority, false);
  assert.equal(content.notification.delivery_id, "delivery-one");
  assert.match(content.instruction, /Não execute ação reservada/);
  assert.deepEqual(acknowledged, [notification]);
});

test("silent supervisor does not acknowledge a notification the chat did not accept", async () => {
  let acknowledged = false;
  const pi = { async sendMessage() { throw new Error("chat unavailable"); } };
  const control = {
    async nextNotification() { return notification; },
    async acknowledgeNotification() { acknowledged = true; },
  };
  await assert.rejects(() => runSilentSupervisorTick(pi, control, { isIdle: () => true }), /chat unavailable/);
  assert.equal(acknowledged, false);
});

test("silent supervisor never competes with an active conversational turn", async () => {
  let observed = false;
  const result = await runSilentSupervisorTick({}, {
    async nextNotification() { observed = true; },
  }, { isIdle: () => false });
  assert.equal(result.outcome, "busy");
  assert.equal(observed, false);
});

test("project discovery is exposed through the structured control tool", async () => {
  const calls = [];
  const control = {
    async discoverProjects(query) {
      calls.push(query);
      return { ok: true, match: "exact", candidates: [{ name: "vitalis-teste" }] };
    },
  };
  const result = await executeControlAction(control, { action: "discover_projects", project_query: "vitalis-teste" });
  assert.equal(result.match, "exact");
  assert.deepEqual(calls, ["vitalis-teste"]);
});

test("preexisting run discovery and tracking are exposed through the structured control tool", async () => {
  const calls = [];
  const control = {
    async discoverRuns(query) {
      calls.push(["discover", query]);
      return { ok: true, candidates: [{ candidate_id: "run-one" }] };
    },
    async trackRun(query, candidateId) {
      calls.push(["track", query, candidateId]);
      return { ok: true, outcome: "tracked" };
    },
    async sendTrackedRunMessage(input) {
      calls.push(["send", input]);
      return { ok: true, state: "sent", applied: false };
    },
  };
  assert.equal((await executeControlAction(control, {
    action: "discover_runs", project_query: "proj-lainny",
  })).candidates[0].candidate_id, "run-one");
  assert.equal((await executeControlAction(control, {
    action: "track_run", project_query: "proj-lainny", candidate_id: "run-one",
  })).outcome, "tracked");
  assert.equal((await executeControlAction(control, {
    action: "send_tracked_run_message", delivery_id: "delivery-one", message: "Continue", authorization: "explicit-current-turn",
  })).state, "sent");
  assert.deepEqual(calls, [
    ["discover", "proj-lainny"],
    ["track", "proj-lainny", "run-one"],
    ["send", { delivery_id: "delivery-one", message: "Continue", authorization: "explicit-current-turn" }],
  ]);
});
