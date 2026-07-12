/** @description Locked tests for isDeliveryCommand (OC ship detector). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeliveryCommand } from "./is-delivery-command.mjs";

test("gh pr create → true", () => {
  assert.equal(isDeliveryCommand("gh pr create --title x"), true);
});

test("git -C push → true", () => {
  assert.equal(isDeliveryCommand("git -C /repo push origin HEAD"), true);
});

test("composite && gh pr merge → true", () => {
  assert.equal(isDeliveryCommand("echo ok && gh pr merge 1"), true);
});

test("readonly git status / gh pr view → false", () => {
  assert.equal(isDeliveryCommand("git status"), false);
  assert.equal(isDeliveryCommand("gh pr view 1"), false);
});
