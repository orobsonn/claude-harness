/** @description Compatibility re-export: monorepo layout keeps real engine at core/vps/; hooks/skills under claude-code resolve via this shim (vendored layout copies real modules into .claude/vps/). */
export * from "../../vps/obs-outbox.mjs";
