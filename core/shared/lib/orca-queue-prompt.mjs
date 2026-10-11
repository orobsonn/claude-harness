/** @description Default delivery brief for the selected project's native harness. */
export function defaultQueuePrompt(agent) {
  if (agent === "pi") {
    return "Execute autonomamente a issue vinculada a esta worktree. Leia a issue e siga AGENTS.md " +
      "e somente o harness Pi vendorizado em .pi/: triage, spec quando aplicável, revisões, " +
      "plano aprovado, harness_tasks, testes, olhos finais, harvest e shipper. " +
      "A issue é o requisito, não uma spec já aprovada. Entregue PR draft com Closes #N " +
      "e evidência verificada; merge, deploy e efeitos de produção exigem autorização explícita.";
  }
  return "Rode em MODO AUTÔNOMO (headless). A issue é a spec. Siga a entry-policy do .claude/ deste " +
    "repo: triaging -> orchestrating-delivery headless. Entregue PR (Closes #N) com memória + " +
    "kaizen + testes. NUNCA AskUserQuestion nem plan-mode.";
}
