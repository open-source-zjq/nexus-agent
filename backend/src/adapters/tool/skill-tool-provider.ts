import type { ToolProvider } from "./capability-registry.js";
import { defineTool } from "./types.js";
import type { SkillRuntime } from "../../skills/skill-runtime.js";

export interface SkillToolProviderConfig {
  enabled?: boolean;
  roots?: string[];
}

/**
 * Builds the `skill` tool provider, exposing a single `load_skill` tool that
 * pulls a skill's full instructions on demand by id (mirroring the catalog the
 * runtime folds into the system prefix). Faithful to the original
 * buildSkillToolProviders: the provider is hidden (reports available=false)
 * whenever no skills are actually loaded (`runtime.count() === 0`), regardless
 * of whether skills are nominally enabled or roots are configured — so the
 * default tool catalog stays byte-identical when there are zero skills.
 */
export function buildSkillToolProvider(
  runtime: SkillRuntime,
  config: SkillToolProviderConfig,
): ToolProvider {
  const enabled = Boolean(config.enabled);
  // Original gate: `if (!skillRuntime || skillRuntime.count() === 0) return []`.
  // count() is 0 when skills are disabled or none loaded.
  const hasSkills = runtime.count() > 0;

  return {
    id: "skill",
    kind: "skill",
    enabled,
    available: hasSkills,
    ...(hasSkills ? {} : { reason: enabled ? "no skills loaded" : "skills are disabled" }),
    tools: [
      defineTool({
        name: "load_skill",
        description: [
          "Load the full instructions of an available skill by its id (see the",
          '"Available skills" catalog in your system context). Call this when a',
          "request matches a skill but the skill did not auto-activate, then",
          "follow the returned instructions. Returns the skill's SKILL.md body",
          "plus its metadata and any tool constraints.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            skill_id: {
              type: "string",
              description:
                'The skill id from the catalog (e.g. "code-review"). The leading $/@ or "skill:" prefix is optional.',
            },
          },
          required: ["skill_id"],
          additionalProperties: false,
        },
        policy: "auto",
        execute: async (args) => {
          const skillId = typeof args.skill_id === "string" ? args.skill_id : "";
          if (!skillId.trim())
            return { output: { error: "skill_id is required" }, isError: true };
          const result = runtime.loadSkillById(skillId);
          if ("error" in result) return { output: result, isError: true };
          return { output: result };
        },
      }),
    ],
  };
}
