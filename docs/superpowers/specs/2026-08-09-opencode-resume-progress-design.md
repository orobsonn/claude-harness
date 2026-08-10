# OpenCode Resume Progress Design

## Goal

Resume an approved OpenCode feature after an interrupted session without losing verified task progress from prior resumed sessions.

## Evidence

In VPS `vps-gestao`, source session `ses_0194aa1a1ffeR0AW4QE53zFtui` has the canonical approved plan but no captured tasks. Its resumed session `ses_0184814e7ffeWH5vIowxX0uMGq` has five `capture_verified` tasks. The current finder only enumerates canonical plan directories, so a later session chooses the first state and drops the five verified completions.

## Design

`findFeatureResume` will inspect validated gate states for the requested feature and resolve every candidate to its canonical plan identity. It will choose the most advanced resumable state only within that plan identity; progress from a different revision never crosses into the selected state.

The adopted state keeps the canonical plan session in `resumed_from_session_id`, so plan lookup remains stable. A separate field records the immediate session from which progress was recovered. Candidates with terminal delivery state, active planner leases, invalid plan/snapshot bindings, or invalid task progress are not eligible.

Native todo projection remains a read-only projection of the adopted state.

## Validation

Regression tests model one canonical session plus a later resumed session with verified captures. They assert that the later state is adopted, task progress is retained, the canonical-plan pointer is not redirected to a non-canonical session, and a separate plan revision cannot donate progress.
