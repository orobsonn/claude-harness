# lavish-axi usage — internal reference (read by `oc-grill` only)

Adapted from the upstream `lavish` skill (github.com/kunchenguid/lavish-axi, MIT, author Kun Chen).
Vendored once, reviewed, edited for this harness's constraints — **not** a live pull at
init/update time, **not** a standalone discoverable skill. Only `oc-grill` § 9 reads this file;
nothing else in the pipeline invokes it, and the top-level agent cannot pick it up on its own
initiative outside that flow. Re-pulling upstream content into this file is a deliberate, reviewed
PR — never automatic, never at a consumer project's vendor/update time.

Reviewed against [lavish-axi 0.1.67](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.67)
on 2026-09-08 (npm `latest`; source `ca4c59d5b3ef84ae7f6f7f93fcaa415ade8a9c73`).
The upstream skill now delegates detailed guidance to CLI `--help`, `design`, and
`playbook <id>`. Consult those when needed; this harness's overrides still win.

## Overrides — non-negotiable, apply on top of anything below

- **No CDN, no remote reference of any kind.** Upstream's own design guidance recommends a
  Tailwind/DaisyUI CDN fallback when no project design system is found — **do not use it here**.
  Every mockup this produces must obey grill's own § 9 content checklist (no `<script>`, no
  `http://`/`https://` anywhere — not in `url()`, `@font-face`, `@import`, `<link>`, `<img src>`,
  form `action=` — inline CSS only, wireframe/placeholder content, never real PRD data). That
  checklist wins over anything here it conflicts with.
- **Default path is `docs/prd/<slug>-mockup.html`**, not upstream's `.lavish/<name>.html` default.
  One file per slug — overwrite on a later request for the same slug, never accumulate a second
  file.
- **`lavish-axi share` is forbidden.** It publishes the artifact to a third-party host (ht-ml.app),
  public by default. Never invoke it, never suggest it to the operator.
- **`lavish-axi setup hooks` is forbidden.** It installs a `SessionStart` hook that competes with
  this harness's own entry-policy hook. Never invoke it.
- **Poll stays in the foreground.** Never background it with `nohup` / `&` / `disown` / a detached
  terminal. If the Bash tool call times out before feedback arrives, re-run
  `lavish-axi poll <file>`; undelivered feedback stays queued. A delivered response is consumed:
  read it completely before filtering or truncating output. Do not add `--timeout-ms` in normal use.
- **Version stays unpinned** (`npx -y lavish-axi`, no `@version`) — accepted, operator-approved
  residual risk, consistent with the rest of this skill's invocation.

## Workflow

1. Write the mockup HTML to `docs/prd/<slug>-mockup.html`, following grill's § 9 content checklist.
2. `npx -y lavish-axi docs/prd/<slug>-mockup.html` — opens or resumes the review session in the
   operator's browser. If `npx -y` fails outright (no network, registry unreachable, broken
   release), fall back to the pre-lavish path: state the file's location in pt-br and let the
   operator open it directly from disk — never treat this as a hard failure of the mockup step.
3. `npx -y lavish-axi poll docs/prd/<slug>-mockup.html` — waits for feedback, an end, or a browser
   disconnect beyond the reconnect grace period. On the first poll, pass
   `--agent-reply "<one-line summary of what you built and what to review first>"` so the panel
   opens with context.
4. Layout detection is passive: the browser collects issues in its Layout issues inbox and does
   not wake the agent. Only operator-selected fixes arrive as a prompt tagged `layout-warnings`.
   Apply all listed fixes in one pass before saving. A queued issue is not resolved until a newer
   artifact load and complete check at the same viewport confirm it. An `artifact_failures`
   response is the exception: repair the fatal failure that made the review surface unusable.
5. Apply the operator's feedback, then poll again with `--agent-reply "<message>"` to keep the loop
   going. If `session.status` is `browser_disconnected`, stop polling and ask whether the operator
   wants to resume or end; the session remains resumable. Do not reopen or end it uninvited.
6. `npx -y lavish-axi end docs/prd/<slug>-mockup.html` when the review is done, or let the operator
   end it from the browser (`Send & End`). A final feedback response can also carry
   `session.session_ended: true`: apply that feedback, stop polling, and report in chat.
   Never reopen the session uninvited; use `--reopen` only after the operator requests more review.

Fold the operator's reaction into the interview like any other answer (see grill's own § 9 —
"ordinary interview input, nothing more").

## Optional facilities, subject to the overrides

- Inline SVG is the default figure medium. Mermaid is opt-in for an explicitly requested editable
  whiteboard and still cannot add scripts or remote renderers to the mockup. Rendered Mermaid
  diagrams become editable Excalidraw whiteboards in the browser; edits come back
  through `poll` as a `whiteboard` prompt carrying a bounded summary plus local scene/preview file
  paths — read the summary first, apply the edit by updating the Mermaid source in the artifact
  itself, never write the scene file back.
- Playbooks (`npx -y lavish-axi playbook <id>`): `diagram`, `table`, `comparison`, `plan`, `code`,
  `input`, `slides` — open whichever matches what the mockup needs to show before writing the HTML.
  The input playbook's tracked batch examples use scripts/event handlers; do not copy those into
  Grill's static mockups. Receive decisions through Lavish's own annotation/chat controls.
- Image attachments in feedback carry absolute local `path` values; open the supplied image when
  it explains the request. Do not copy private image content into placeholder mockups.
- `npx -y lavish-axi export docs/prd/<slug>-mockup.html` produces a standalone copy with local
  assets inlined — offer it if the operator wants a portable copy; still respects the
  no-remote-reference rule since the mockup never had remote assets to begin with.

## Explicitly not used here

- `share` — forbidden above (third-party publish, public by default).
- `setup hooks` — forbidden above (competes with the harness's own SessionStart hook).
- The CDN/Tailwind/DaisyUI design-system fallback — forbidden above (inline CSS only).
- The `.lavish/` default directory — this uses `docs/prd/`, the PRD's own directory, instead.
