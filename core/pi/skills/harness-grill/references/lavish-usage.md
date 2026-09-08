# Lavish — referência interna do Grill

Adapted from the MIT-licensed lavish-axi skill by Kun Chen
(github.com/kunchenguid/lavish-axi) and the reviewed Claude Code harness reference.
This is packaged content, not an upstream download during harness init/update,
and not a standalone discoverable skill. Read only for a requested Grill mockup.

Reviewed against [lavish-axi 0.1.67](https://github.com/kunchenguid/lavish-axi/releases/tag/lavish-axi-v0.1.67)
on 2026-09-08 (npm `latest`; source `ca4c59d5b3ef84ae7f6f7f93fcaa415ade8a9c73`).
Upstream now keeps detailed guidance in CLI `--help`, `design`, and `playbook <id>`;
consult those when needed, with this harness's constraints taking precedence.

## Constraints

Grill's static placeholder HTML rules take precedence over upstream examples:
inline CSS only, no scripts/event handlers, no remote references, no real PRD data.
No Tailwind/DaisyUI CDN fallback. One `docs/prd/<slug>-mockup.html` per idea;
overwrite it for revisions instead of using the upstream `.lavish/` default.

`lavish-axi share` is forbidden: it publishes to the third-party ht-ml.app host,
public by default. `lavish-axi setup hooks` is forbidden: it installs a competing
session hook. Do not suggest either command. Local review is not permission to publish.

Invocation remains `npx -y lavish-axi` without a version pin, matching the existing
operator-approved residual risk in the Claude Code integration. Do not install
its hooks, change project dependencies or fetch/replace this reference at runtime.

## Local review loop

1. Write the requested static mockup following the skill's content constraints.
2. Open or resume: `npx -y lavish-axi docs/prd/<slug>-mockup.html`.
3. Wait for feedback in the foreground:
   `npx -y lavish-axi poll docs/prd/<slug>-mockup.html --agent-reply "Veja a hierarquia e me diga o que mudar."`
4. Layout detection is passive: the browser collects issues in its Layout issues
   inbox. Only operator-selected fixes arrive as prompts tagged `layout-warnings`.
   Apply all listed fixes in one pass before saving the same file. A queued issue
   is resolved only after a newer load and complete check at the same viewport.
   `artifact_failures` is the exception: repair the fatal failure that made the
   review surface unusable. Poll again with a brief `--agent-reply` after feedback.
5. A tool timeout before feedback arrives means run poll again; do not use `nohup`,
   `&`, `disown`, detached terminals or an automation. Undelivered feedback stays
   queued, but a delivered response is consumed: read it completely before filtering
   or truncating output. Do not add `--timeout-ms` in normal use. If `session.status`
   is `browser_disconnected`, stop polling and ask whether the operator wants to
   resume or end; the session remains resumable. Do neither uninvited.
6. Stop when the operator ends the session. To end an approved finished review,
   use `npx -y lavish-axi end docs/prd/<slug>-mockup.html`. A final feedback response
   can carry `session.session_ended: true`: apply that feedback and report in chat
   without polling again. Do not reopen uninvited; use `--reopen` only after the
   operator requests more review.

If startup fails (network/registry/tool unavailable), offer the static file instead:
`open docs/prd/<slug>-mockup.html` on macOS or `xdg-open` on Linux when available.
Otherwise state its path. Do not block discovery or claim interactive feedback worked.
Fold actual operator feedback into the PRD, keeping deductions separate from decisions.

## Optional facilities

- `playbook <id>` can inform layout: diagram, table, comparison, plan, code, input
  or slides. Its output does not override the static/no-remote/placeholder rules.
  Do not copy the input playbook's scripted tracked batch controls; receive decisions
  through Lavish's annotation/chat controls instead.
- Inline SVG is the default figure medium; Mermaid is opt-in for a requested editable
  whiteboard, still without scripts or remote renderers in the mockup.
  Mermaid/Excalidraw whiteboard feedback includes a summary and local scene/preview
  paths. Read the summary first and update the artifact's diagram source; do not
  copy the scene file back or embed a remote renderer.
- Image attachments in feedback carry absolute local `path` values. Open the image
  when it explains the request; do not copy private image content into the mockup.
- Offer `export docs/prd/<slug>-mockup.html` only if the operator asks for a portable
  copy. Still no remote assets or real PRD content.
