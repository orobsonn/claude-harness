/** @description Strict delimiter and JSON tests for official Task prompt identity. */

import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskDispatchIdentity } from "./task-dispatch-identity.mjs";

const OPEN = "[HARNESS_TASK_CONTEXT]";
const CLOSE = "[/HARNESS_TASK_CONTEXT]";
const JSON_BODY = '{"task_id":"task-1"}';

test("task marker accepts exactly one ordered complete block", () => {
  assert.deepEqual(parseTaskDispatchIdentity(`Before\n${OPEN}${JSON_BODY}${CLOSE}\nAfter`), { ok: true, taskId: "task-1" });
});

test("task marker rejects extra closes before or after the valid block", () => {
  for (const prompt of [
    `${CLOSE}${OPEN}${JSON_BODY}${CLOSE}`,
    `${OPEN}${JSON_BODY}${CLOSE}${CLOSE}`,
  ]) assert.equal(parseTaskDispatchIdentity(prompt).ok, false);
});

test("task marker rejects duplicate, nested, reversed, and trailing markers", () => {
  for (const prompt of [
    `${OPEN}${JSON_BODY}${CLOSE}${OPEN}${JSON_BODY}${CLOSE}`,
    `${OPEN}${OPEN}${JSON_BODY}${CLOSE}${CLOSE}`,
    `${CLOSE}${JSON_BODY}${OPEN}`,
    `${OPEN}${JSON_BODY}${CLOSE}${OPEN}`,
    `${OPEN}${JSON_BODY}${CLOSE} trailing ${CLOSE}`,
  ]) assert.equal(parseTaskDispatchIdentity(prompt).ok, false);
});

test("task marker rejects malformed JSON and non-exact payload shape", () => {
  for (const body of [
    '{"task_id":',
    '{"task_id":"task-1","task_id":"task-2"}',
    '{"task_id":"task-1","feature_id":"foreign"}',
    '{"task_id":"bad task"}',
  ]) assert.equal(parseTaskDispatchIdentity(`${OPEN}${body}${CLOSE}`).ok, false);
});
