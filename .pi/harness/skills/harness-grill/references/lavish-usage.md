# Lavish — referência interna do Grill

Adapted from the MIT-licensed lavish-axi skill by Kun Chen
(github.com/kunchenguid/lavish-axi) and the reviewed Claude Code harness reference.
This is packaged content, not an upstream download during harness init/update,
and not a standalone discoverable skill. Read only for a requested Grill mockup.

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
4. Read feedback and any `layout_warnings`; fix layout failures and apply feedback
   to the same file. Poll again with a brief `--agent-reply` describing the change.
5. A tool timeout during poll is expected: run poll again; do not use `nohup`, `&`,
   `disown`, detached terminals or an automation. Queued feedback remains available.
6. Stop when the operator ends the session. To end an approved finished review,
   use `npx -y lavish-axi end docs/prd/<slug>-mockup.html`. Do not reopen uninvited.

If startup fails (network/registry/tool unavailable), offer the static file instead:
`open docs/prd/<slug>-mockup.html` on macOS or `xdg-open` on Linux when available.
Otherwise state its path. Do not block discovery or claim interactive feedback worked.
Fold actual operator feedback into the PRD, keeping deductions separate from decisions.

## Optional facilities

- `playbook <id>` can inform layout: diagram, table, comparison, plan, code, input
  or slides. Its output does not override the static/no-remote/placeholder rules.
- Mermaid/Excalidraw whiteboard feedback includes a summary and local scene/preview
  paths. Read the summary first and update the artifact's diagram source; do not
  copy the scene file back or embed a remote renderer.
- Offer `export docs/prd/<slug>-mockup.html` only if the operator asks for a portable
  copy. Still no remote assets or real PRD content.
