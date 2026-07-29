/**
 * @description The OC post-sniper adversary loop must have a CEILING on the stagnation escalation
 * (#565): escalate → operator answers "repensa" → the loop reopens at round 1 → it stagnates again
 * on the SAME finding → the outcome is a terminal CRITICAL EXCEPTION, never the same escalation a
 * second time.
 *
 * Why this exists: stagnation fires from round 2, and the "repensa" branch reopens the loop at
 * round 1 — so the sequence escalate→repensa→stagnate→escalate had no ceiling by construction. Each
 * cycle was evaluated as if it were the first: nothing recognised "this exact finding, on this exact
 * task, was already escalated and already repensa-ed", so the operator could be asked the same
 * product question forever while the run never converged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const lines = skill.split("\n");

/**
 * One rule and its continuation, anchored on the STABLE issue marker rather than on a bold title or
 * an item number: from the line carrying the marker up to the next line that opens a new bullet, a
 * new numbered item, or a new top-level block. Reformulating a title, or inserting an item above,
 * must not redden CI; swallowing the NEXT rule must not green it.
 */
function ruleMarked(marker) {
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.length > 0 && (!/^\s/.test(line) || /^\s*(?:\d+\.|[-*])\s/.test(line)),
  );
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

function ruleStartingWith(prefix) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.length > 0 && (!/^\s/.test(line) || /^\s*(?:\d+\.|[-*])\s/.test(line)),
  );
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const escalateItem = ruleStartingWith("2. **Escalate now.");
const ceilingItem = ruleMarked("#565 #ac-1.1");
const keyItem = ruleMarked("#565 #ac-1.3");
const matchItem = ruleMarked("#565 #ac-1.2");
const capRule = ruleStartingWith("- **CAP = 3 rounds");

test("OC orchestrating-delivery: a repeated stagnation is terminal, not a second escalation (#565 #ac-1.1)", () => {
  assert.ok(
    ceilingItem,
    "the stagnation paragraph must carry an explicit ceiling, marked `#565 #ac-1.1` — without it, " +
      "escalate→repensa→stagnate→escalate is unbounded by construction and the operator answers the " +
      "same question forever.",
  );
  assert.match(
    ceilingItem,
    /CRITICAL EXCEPTION/,
    "the terminal must be the run's existing terminal state (CRITICAL EXCEPTION), not a new " +
      "bespoke outcome the rest of the document does not handle.",
  );
  assert.match(
    ceilingItem,
    /not (?:another|a second) escalation/i,
    "the ceiling must deny the second escalation explicitly — 'escalate again but louder' is the " +
      "exact behaviour this issue closes.",
  );
  assert.match(
    ceilingItem,
    /already[\s\S]{0,120}`repensa`|answered[\s\S]{0,40}`repensa`/i,
    "the trigger must be the SECOND stagnation of a key already escalated and answered `repensa` — " +
      "a first stagnation still gets its escalation.",
  );
  assert.match(
    ceilingItem,
    /`stagnation_key`/,
    "the ceiling must resolve through the tracked key, or 'the same finding' stays a judgement call " +
      "made fresh each cycle — which is how the loop got here.",
  );
});

test("OC orchestrating-delivery: the ceiling covers every reopening escalation (#565 #ac-1.1)", () => {
  // The CAP = 3 branch reopens the loop with the same words ("repensa" → a NEW loop at round 1). A
  // ceiling scoped to the stagnation branch alone leaves the identical ping-pong running through
  // the sibling exit: a finding whose severity distribution keeps changing never stagnates, reaches
  // round 3, escalates, is repensa-ed, and comes back forever.
  assert.match(
    ceilingItem,
    /CAP = 3/,
    "the ceiling's trigger must cover the CAP = 3 escalation too, not only the stagnation stop.",
  );
  assert.match(
    ceilingItem,
    /both directions|either stop/i,
    "the two stops must be named as one channel for this purpose, in BOTH directions — a ceiling " +
      "that only recognises an earlier CAP escalation still lets the reopened loop re-escalate " +
      "through the sibling exit.",
  );
  assert.match(
    ceilingItem,
    /without ever stagnating|without stagnating/i,
    "the sibling path must be spelled out: a reopened loop whose severity distribution keeps " +
      "changing never stagnates, reaches round 3, and escalates the same question again.",
  );
});

test("OC orchestrating-delivery: step h carries the protected block forward (#565 #ac-1.3)", () => {
  // The rule that keeps the record alive is useless where it cannot be seen: step h is written as a
  // full rewrite of the ledger from what is in context, which after a compaction deletes the very
  // block the ceiling reads.
  const stepH = lines.find((line) => line.startsWith("| h | Record |"));
  assert.ok(stepH, "the Per-task steps table must keep step h (Record) as a single row.");
  assert.match(
    stepH,
    /read-modify-write|read the file off disk first/i,
    "step h itself must say the rewrite is read-modify-write — an orchestrator executing from the " +
      "table never reads the stop-rule section's fine print.",
  );
  assert.match(
    stepH,
    /`stagnation_key`/,
    "step h must name the protected block's contents, or 'protected' is a promise with no referent.",
  );
});

test("OC orchestrating-delivery: the terminal stamps nothing and names what stays blocked (#565 #ac-1.1)", () => {
  assert.match(
    ceilingItem,
    /stamps nothing|no stamp/i,
    "a terminal is not an accept: it must authorize no `regate-passed`, or the ceiling becomes a " +
      "greener exit than the fix it replaces.",
  );
  assert.match(
    ceilingItem,
    /`regate_pending`[\s\S]{0,120}unmatched/i,
    "the unmatched rail must be stated so a later restart is not mistaken for a ship-blocked bug — " +
      "the same convention the other CRITICAL EXCEPTION branches already follow.",
  );
  assert.match(
    ceilingItem,
    /git push|`shipper`/,
    "the blast radius must be named: an unmatched rail denies delivery for the WHOLE run, not just " +
      "this task — an operator told only 'the task ended' cannot see that.",
  );
  assert.match(
    ceilingItem,
    /accept/i,
    "the ceiling must name the one exit that still clears the rail (the accept route of the " +
      "accepted-risk section), or the terminal is an undocumented dead end for the whole run.",
  );
  assert.match(
    ceilingItem,
    /pt-br/i,
    "the operator message stays pt-br product language, like every other escalation on this channel.",
  );
});

test("OC orchestrating-delivery: the terminal asks nothing that could reopen the loop (#565 #ac-1.1)", () => {
  // § Escalation ladder defines CRITICAL EXCEPTION as a question to the operator ("(a) aceita
  // (b) repensa?"). Reusing that template here would let a "repensa" answer reopen the very loop
  // the ceiling just closed — the ceiling would become the second escalation it forbids.
  assert.match(
    ceilingItem,
    /\(a\) aceita|no question|carries no question/i,
    "the terminal must opt out of the '(a) aceita (b) repensa' template explicitly, or the state " +
      "carries two opposite orders and the loop reopens.",
  );
  assert.match(
    ceilingItem,
    /(?:no answer reopens|the task is over|re-scop)/i,
    "the consequence must be stated: nothing the operator answers reopens this loop; another " +
      "attempt is a re-scope in a new run.",
  );
});

test("OC orchestrating-delivery: the ceiling never outranks the stronger hand (#565 #ac-1.1)", () => {
  // Stagnation fires from round 2 — the same state #544's climb rule owns. A terminal there, with
  // an unspent Axis-2 tier step, would hand the operator an engineering decision the ladder had not
  // finished: engineering is never delegated to the human, and never delegated twice.
  assert.match(
    ceilingItem,
    /Precedence/i,
    "the ceiling must state its precedence against the Axis-2 stronger-hand rule that opens this " +
      "bullet — otherwise one state carries two opposite orders.",
  );
  assert.match(
    ceilingItem,
    /climb|tier step/i,
    "the precedence must name the move that still wins first (the climb to the executor one tier up).",
  );
  assert.match(
    ceilingItem,
    /(?:not yet spent|still unspent|unspent)/i,
    "the precedence must be conditioned on the unspent tier step, exactly like the bullet's opening " +
      "precedence — an unconditional terminal would swallow the climb.",
  );
});

test("OC orchestrating-delivery: the terminal is defined in Phase 3 too (#565 #ac-1.1)", () => {
  // Phase 3's final review has no task and no `task_id`; a terminal written purely in terms of
  // "ends the task" / "that `task_id`'s rail" is undefined exactly in the phase whose surface is
  // the whole feature.
  assert.match(
    ceilingItem,
    /Phase 3/,
    "the terminal must say what it ends when there is no task — the key's Phase 3 carve-out alone " +
      "leaves the outcome undefined.",
  );
  assert.match(
    ceilingItem,
    /final review/i,
    "Phase 3's terminal must name its unit (the final review), not silently inherit 'the task'.",
  );
});

test("OC orchestrating-delivery: the tracking key is concrete, prose-proof and defect-precise (#565 #ac-1.3)", () => {
  assert.ok(
    keyItem,
    "#ac-1.3 requires the tracking mechanism to be defined concretely — 'remember you already saw " +
      "this' is not a mechanism.",
  );
  assert.match(
    keyItem,
    /`task_id`/,
    "the key must be scoped by task, or one task's ceiling silently caps another's first stagnation.",
  );
  assert.match(
    keyItem,
    /`category`[\s\S]{0,200}`scope`/,
    "the key must hang on the adversary report's own literal fields, not on a classification " +
      "re-derived by judgement each round.",
  );
  assert.match(
    keyItem,
    /`evidence`/,
    "`category` + `scope` alone is the signature of the case the climb rule calls expected (same " +
      "class, same file, NEW defect the fix created) — without the report's `evidence` anchor the " +
      "key collides and terminates a finding the operator never saw (#ac-1.2).",
  );
  assert.match(
    keyItem,
    /not[\s\S]{0,80}`description`|never[\s\S]{0,80}`description`/,
    "the key must exclude the finding's prose explicitly: every re-dispatch is fresh-virgin and " +
      "re-words the same defect, so a prose key lets a re-titled repeat through the ceiling.",
  );
  assert.match(
    keyItem,
    /fresh-virgin/,
    "the reason must be stated, or the field choice reads as arbitrary and gets 'simplified' back " +
      "to matching on the title.",
  );
  assert.match(
    keyItem,
    /drift[\s\S]{0,600}(?:new\W{0,4}key|first stagnation|asking once more|never toward silencing)/i,
    "the residual risk must be owned: a re-labelled repeat reads as a new key, and the rule must " +
      "say which way that errs — toward escalating again, never toward silencing a finding.",
  );
  assert.match(
    keyItem,
    /never a line number|never a line/i,
    "the anchor must be the enclosing `file:function`, never a line number: every `repensa` " +
      "produces a fix that shifts lines, so a line-anchored key never matches its own repeat and " +
      "the ceiling silently never fires — the #565 defect preserved under a new mechanism.",
  );
  assert.match(
    keyItem,
    /different trigger/i,
    "the residual collision (a NEW defect the fix grew inside the same function) must have a stated " +
      "tie-break, or the anchor merely moves the #ac-1.2 false-terminal one level down.",
  );
});

test("OC orchestrating-delivery: the key's write has a moment, not just a place (#565 #ac-1.3)", () => {
  // The ceiling triggers on "already recorded as answered `repensa`". The only timing prescribed
  // nearby is item 1's "at the moment the loop stops" — which is BEFORE the operator answers. A key
  // written then, and never updated, never satisfies the trigger: the ping-pong survives intact.
  assert.match(
    keyItem,
    /at the moment the operator's answer arrives|when the operator's answer arrives/i,
    "the write must be pinned to the arrival of the operator's answer — a key recorded at the " +
      "loop's stop carries no answer and arms nothing.",
  );
  assert.match(
    keyItem,
    /before the reopened loop's first re-dispatch|before the first re-dispatch/i,
    "the deadline must precede the reopened loop, or a compaction between the answer and the write " +
      "loses exactly the fact the ceiling reads.",
  );
  assert.match(
    keyItem,
    /arms nothing|does not count/i,
    "the incomplete record must be explicitly inert, so a key with no answer is never read as a " +
      "spent `repensa`.",
  );
});

test("OC orchestrating-delivery: the key lives on disk and survives compaction (#565 #ac-1.3)", () => {
  assert.match(
    keyItem,
    /`shared_context\.md`/,
    "the key must live in the run's on-disk ledger — the same place the round counter and the " +
      "Axis-2 SPENT flag already live.",
  );
  assert.match(
    keyItem,
    /via bash|step h/i,
    "the write must be the existing step-h bash write, not an invented side-channel.",
  );
  assert.match(
    keyItem,
    /compaction/i,
    "#ac-1.3 asks what the tracking survives: compaction is the failure mode — a record held in " +
      "context resets to empty exactly on the long run that reaches a second stagnation.",
  );
  assert.match(
    keyItem,
    /read-modify-write|read the file off disk first/i,
    "step h REWRITES the whole ledger from what is in context, so 'never evicted' is not enough: " +
      "the writer must read the protected block off disk and copy it forward, or the post-compaction " +
      "rewrite deletes the very record the ceiling depends on.",
  );
  assert.match(
    keyItem,
    /verbatim/i,
    "the copy-forward must be verbatim — a block reconstructed from memory is the same loss with " +
      "extra steps.",
  );
  assert.match(
    keyItem,
    /budget cap|never evicts/i,
    "the ledger is budget-capped, so the record must be declared load-bearing state the cap never " +
      "evicts — otherwise it is trimmed away as if it were knowledge.",
  );
  assert.match(
    keyItem,
    /never held in memory alone|never off memory/i,
    "memory-only tracking is the defect restated; the rule must forbid it in words.",
  );
  assert.match(
    keyItem,
    /no gate-state marker|Nothing in the runtime holds/i,
    "the document must say no runtime rail counts stagnations — a reader who assumes gate-state " +
      "does this will never write the record at all.",
  );
});

test("OC orchestrating-delivery: the key's blast radius is bounded (#565 #ac-1.3)", () => {
  assert.match(
    keyItem,
    /per `task_id`[\s\S]{0,240}(?:never inherits|starts with none)/i,
    "keys must not leak across tasks: a new task in the same run starts clean.",
  );
  assert.match(
    keyItem,
    /(?:when a task ends|leave the protected block)/i,
    "the protected block must be cleaned as tasks end — an ever-growing non-evictable block eats " +
      "the very budget the ledger's cap exists to ration.",
  );
  assert.match(
    keyItem,
    /harvester/,
    "the rule must say how far the record has to live — it fires inside Phase 2/3 and never needs " +
      "to survive the harvest, unlike the open-risk signal of item 1.",
  );
  assert.match(
    keyItem,
    /Phase 3/,
    "Phase 3's final review has no `task_id` (§ Phase 2 scope) — the key's variant there must be " +
      "stated or the ceiling is undefined in exactly the phase that reviews the whole feature.",
  );
});

test("OC orchestrating-delivery: only an exact repeat is capped (#565 #ac-1.2)", () => {
  assert.ok(
    matchItem,
    "the ceiling must scope itself — a cap that swallows genuinely different findings converts a " +
      "ping-pong bug into a silently-truncated review.",
  );
  assert.match(
    matchItem,
    /first stagnation/i,
    "an unrecorded key must be treated as a FIRST stagnation and follow the normal escalation, " +
      "however many other keys the task already burned.",
  );
  assert.match(
    matchItem,
    /same `category`[\s\S]{0,120}same `scope`[\s\S]{0,120}different `evidence`/i,
    "the collision case must be settled in words: same class, same file, different anchor is the " +
      "NEW defect the previous fix created — the failure mode the climb rule exists for — and it " +
      "must flow normally instead of inheriting the old finding's ceiling.",
  );
  assert.match(
    matchItem,
    /genuinely fixed|does not come back/i,
    "#ac-1.2's second half: a finding that was really fixed never reappears, so it can never match " +
      "the ceiling.",
  );
  assert.match(
    matchItem,
    /Only the exact repeat[\s\S]{0,160}anchor/i,
    "the terminal condition must be restated with every field of the key, anchor included — a " +
      "three-field restatement re-opens the collision the key closed.",
  );
});

test("OC orchestrating-delivery: headless never reaches the ceiling (#565 #ac-1.2)", () => {
  // With no operator there is no "repensa": item 2's headless branch advances the run on the signal
  // instead of reopening the loop, so no key is ever recorded as answered.
  assert.match(
    matchItem,
    /HEADLESS never reaches this ceiling/i,
    "the headless branch must be settled explicitly — a ceiling that fired with no operator in the " +
      "turn would terminate cloud runs on a state that cannot ping-pong there.",
  );
  assert.doesNotMatch(
    ceilingItem,
    /HEADLESS records it/i,
    "the terminal must not carry a headless branch of its own while the scope rule says headless " +
      "never reaches it — two readings of one state is how the wrong exit gets chosen.",
  );
});

test("OC orchestrating-delivery: the reopened loop declares its own bound (#565 #ac-1.1)", () => {
  assert.ok(escalateItem, "the 'Escalate now' item must survive as its own item.");
  assert.match(
    escalateItem,
    /"repensa"[\s\S]{0,160}(?:once|item 3)/i,
    "the branch that reopens the loop must say the grant is bounded, right where it is granted — a " +
      "reader who stops at item 2 must not conclude the reopen is unlimited.",
  );
  assert.ok(capRule, "the CAP = 3 bullet must survive.");
  assert.match(
    capRule,
    /(?:cannot ping-pong back|terminal, not a second escalation|item 3)/i,
    "the CAP bullet claims 'escalating never ping-pongs' about the reopened loop; that claim must " +
      "now point at the ceiling that actually makes it true, instead of asserting it.",
  );
});
