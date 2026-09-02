/**
 * @description Texto plano do resultado de uma tool do Pi. Aceita string, array de blocos
 * `{type:'text',text}`, `{content}`, `{output}` ou `{result}`; qualquer outra forma vira JSON.
 * Nunca lança.
 * @param {unknown} result
 * @returns {string}
 */
export function piResultText(result) {
  try {
    if (result == null) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
      return result
        .filter((block) => block != null && typeof block === "object" && block["type"] === "text")
        .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
        .join("");
    }
    if (typeof result === "object") {
      const inner = result.content ?? result.output ?? result.result ?? null;
      if (inner != null && inner !== result) return piResultText(inner);
      return JSON.stringify(result);
    }
    return String(result);
  } catch {
    return "";
  }
}
