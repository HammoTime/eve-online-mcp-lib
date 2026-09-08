import {
  EsiClient,
  type EsiCallInput,
  type EsiResponse,
} from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { SkillCatalog } from "../src/skill-data.js";
import { SkillPlanner } from "../src/skill-plan.js";
import { safeErrorCode } from "../src/telemetry.js";
import type { OpenApiDocument } from "../src/types.js";

export const SYNTHETIC_RULES = [
  "QUEUE_TIME_ORDER",
  "QUEUE_COMPLETED_CONFLICT",
  "QUEUE_SP_THRESHOLD",
  "SKILL_EVIDENCE_DUPLICATE",
  "PLAN_SP_BASELINE",
] as const;
/** Reviewed stand-ins exercise the invariant without exporting a character's
 * skills, queue, identity, tokens or holdings. This is explicitly a domain replay. */
export async function replaySynthetic(rule: string, document: OpenApiDocument) {
  if (!SYNTHETIC_RULES.some((value) => value === rule))
    throw new Error("No reviewed synthetic fixture exists for this rule");
  const clock = "2026-01-01T00:00:00Z";
  const skill = {
    skill_id: 3300,
    trained_skill_level: 0,
    active_skill_level: 0,
    skillpoints_in_skill: rule === "PLAN_SP_BASELINE" ? 1000000 : 0,
  };
  const skills = {
    skills: rule === "SKILL_EVIDENCE_DUPLICATE" ? [skill, skill] : [skill],
    total_sp: 0,
  };
  const queue =
    rule === "PLAN_SP_BASELINE"
      ? []
      : [
          {
            skill_id: 3300,
            finished_level: 1,
            queue_position: 0,
            start_date:
              rule === "QUEUE_TIME_ORDER"
                ? "2026-01-03T00:00:00Z"
                : "2026-01-01T00:00:00Z",
            finish_date:
              rule === "QUEUE_COMPLETED_CONFLICT"
                ? "2025-12-31T00:00:00Z"
                : "2026-01-02T00:00:00Z",
            level_end_sp: rule === "QUEUE_SP_THRESHOLD" ? 1000000 : 250,
          },
        ];
  let calls = 0;
  const client = new (class extends EsiClient {
    override authorize() {
      return Promise.resolve({ authorizationContext: "esi" as const });
    }
    override call(input: EsiCallInput): Promise<EsiResponse> {
      const expected =
        calls++ === 0
          ? "GetCharactersCharacterIdSkills"
          : "GetCharactersCharacterIdSkillqueue";
      if (calls > 2 || input.operationId !== expected)
        throw new Error("Unexpected synthetic dependency");
      return Promise.resolve({
        operationId: input.operationId,
        status: 200,
        url: "https://synthetic.invalid",
        cached: false,
        headers: {},
        data: calls === 1 ? skills : queue,
        freshness: {
          fetchedAt: clock,
          servedAt: clock,
          expiresAt: null,
          sourceLastModified: null,
        },
        pagination: {
          mode: "none",
          currentPage: null,
          totalPages: null,
          hasMore: null,
          nextCall: null,
        },
      });
    }
  })(new OperationCatalog(document), {
    getAccessToken: () => {
      throw new Error("Synthetic replay cannot use credentials");
    },
  });
  const catalog = new SkillCatalog({
    schemaVersion: 1,
    buildNumber: 1,
    releaseDate: clock,
    fetchedAt: clock,
    sourceUrl: "https://synthetic.invalid/catalog",
    types: [
      {
        id: 3300,
        name: "Gunnery",
        groupId: 255,
        categoryId: 16,
        published: true,
        rank: 1,
        requirements: [],
      },
    ],
  });
  const planner = new SkillPlanner(
    {
      initialize: () =>
        Promise.resolve({ catalog, status: { buildNumber: 1 } }),
    },
    client,
  );
  try {
    await planner.generate({
      characterId: 1,
      targets: [{ typeId: 3300, level: 1 }],
      queuePolicy: "preserve",
    });
  } catch (cause) {
    if (safeErrorCode(cause) !== rule)
      throw new Error(
        "Synthetic fixture did not reproduce the requested invariant",
        { cause },
      );
    return {
      status: "synthetic",
      boundary: "domain",
      rule,
      dependencyCalls: calls,
      description:
        "Reviewed stand-ins reproduce the invariant; no original private state is present",
    };
  }
  throw new Error("Synthetic fixture did not fail");
}
