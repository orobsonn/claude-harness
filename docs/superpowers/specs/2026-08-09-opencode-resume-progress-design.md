# OpenCode Resume Progress Design

## Goal

Resume an approved OpenCode feature after an interrupted session without losing verified task progress from prior resumed sessions.

## Evidence

In VPS `vps-gestao`, source session `ses_0194aa1a1ffeR0AW4QE53zFtui` has the canonical approved plan but no captured tasks. Its resumed session `ses_0184814e7ffeWH5vIowxX0uMGq` has five `capture_verified` tasks. The current finder only enumerates canonical plan directories, so a later session chooses the first state and drops the five verified completions.

## Design

`findFeatureResume` will inspect validated gate states for the requested feature and resolve every candidate to its canonical plan identity. It will choose the most advanced resumable state only when all resumable approved candidates share that identity; concurrent revisions fail closed instead of using timestamps as authority.

The adopted state keeps the canonical plan session in `resumed_from_session_id`, so plan lookup remains stable. A separate field records the immediate session from which progress was recovered. Candidates with terminal delivery state, active planner leases, invalid plan/snapshot bindings, or invalid task progress are not eligible.

When a revision binds a new plan identity, all task-scoped delivery facts are cleared. When a session is adopted, only `capture_verified` facts survive; unfinished hand/fidelity evidence belongs to the source session and is re-verified. Native todo projection remains read-only and accepts only capture SHAs proven ancestral to the current HEAD.

## Validation

Regression tests model one canonical session plus a later resumed session with verified captures. They assert that the later state is adopted, task progress is retained, the canonical-plan pointer is not redirected to a non-canonical session, separate plan revisions cannot donate progress, and partial hand state is re-verified.
