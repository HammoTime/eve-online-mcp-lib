import { attributes, withSpanSync } from "./telemetry.js";
import * as z from "zod/v4";

export const REQUIREMENT_ATTRIBUTES = [
  [182, 277],
  [183, 278],
  [184, 279],
  [1285, 1286],
  [1289, 1287],
  [1290, 1288],
] as const;
export const skillLevel = z.number().int().min(1).max(5);
export const typeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const requirementSchema = z.object({
  skillId: typeId,
  level: skillLevel,
});
export type Requirement = z.infer<typeof requirementSchema>;
export const staticTypeSchema = z.object({
  id: typeId,
  name: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => !value.includes("\0")),
  groupId: typeId,
  categoryId: typeId,
  published: z.boolean(),
  requirements: z.array(requirementSchema).max(6).nullable(),
  rank: z.number().positive().nullable(),
});
export type StaticType = z.infer<typeof staticTypeSchema>;
export const staticCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  buildNumber: typeId,
  releaseDate: z.iso.datetime(),
  sourceUrl: z.url(),
  fetchedAt: z.iso.datetime(),
  types: z.array(staticTypeSchema).min(1).max(200_000),
});
export type StaticCatalog = z.infer<typeof staticCatalogSchema>;

export function decodeRequirements(
  attributes: Map<number, number>,
): Requirement[] {
  const requirements = new Map<number, number>();
  for (const [skillAttribute, levelAttribute] of REQUIREMENT_ATTRIBUTES) {
    const skillId = attributes.get(skillAttribute);
    const level = attributes.get(levelAttribute);
    if (skillId === undefined && level === undefined) continue;
    const requirement = requirementSchema.parse({ skillId, level });
    const previous = requirements.get(requirement.skillId);
    if (previous !== undefined && previous !== requirement.level)
      throw new Error("Conflicting prerequisite levels in SDE");
    requirements.set(requirement.skillId, requirement.level);
  }
  return [...requirements].map(([skillId, level]) => ({ skillId, level }));
}

export function validateCatalog(value: unknown): StaticCatalog {
  return withSpanSync("eve.validateCatalog", () => {
    const catalog = staticCatalogSchema.parse(value);
    const types = new Map(catalog.types.map((type) => [type.id, type]));
    if (types.size !== catalog.types.length)
      throw new Error("Duplicate SDE type IDs");
    for (const type of catalog.types) {
      if (
        type.categoryId === 16 &&
        type.published &&
        (!type.requirements || type.rank === null)
      )
        throw new Error(`Incomplete skill metadata: ${type.id}`);
      for (const requirement of type.requirements ?? []) {
        if (types.get(requirement.skillId)?.categoryId !== 16)
          throw new Error(
            `Missing or non-skill prerequisite: ${requirement.skillId}`,
          );
      }
    }
    return catalog;
  });
}

export const planTargetSchema = z.union([
  z.string().trim().min(1).max(200),
  z.object({ typeId, level: skillLevel.optional() }).strict(),
]);
export type PlanTarget = z.infer<typeof planTargetSchema>;
export const targetListSchema = z.array(planTargetSchema).min(1).max(50);
export const ROMAN_LEVELS = ["", "I", "II", "III", "IV", "V"] as const;

export type SkillMetadata = Omit<StaticCatalog, "types"> & {
  typeCount: number;
  skillCount: number;
};
export type SkillCandidate = Pick<StaticType, "name" | "categoryId"> & {
  typeId: number;
};
export const SKILL_CANDIDATE_LIMIT = 20;

/** Synchronous, build-scoped lookup contract. Hosts own storage and snapshot lifetime. */
export abstract class SkillReader {
  abstract readonly metadata: SkillMetadata;
  abstract getType(id: number): StaticType | undefined;
  /** Published exact matches, in ID order, capped at 21 to detect truncation. */
  abstract findByName(
    normalizedName: string,
    skillsOnly?: boolean,
  ): StaticType[];
  abstract search(query: string): SkillCandidate[];
  /** Only whole public catalog artifacts qualify for replay, never lookup footprints. */
  get diagnosticCatalog(): StaticCatalog | undefined {
    return undefined;
  }
  skill(
    id: number,
  ): StaticType & { requirements: Requirement[]; rank: number } {
    const type = this.getType(typeId.parse(id));
    if (type?.categoryId !== 16 || !type.requirements || type.rank === null)
      throw new Error(`Missing complete skill metadata for ${id}`);
    return type as StaticType & { requirements: Requirement[]; rank: number };
  }
  resolve(target: PlanTarget) {
    target = planTargetSchema.parse(target);
    return withSpanSync("eve.resolve", () => {
      attributes({
        "eve.input.target.kind":
          typeof target === "string" ? "text" : "type_id",
        "eve.sde.build": this.metadata.buildNumber,
        ...(typeof target === "string"
          ? { "eve.input.target.length": target.length }
          : { "eve.input.typeId": target.typeId }),
      });
      let level: number | undefined;
      let matches: StaticType[];
      let match = "id";
      if (typeof target === "string") {
        let name = target.trim().toLowerCase();
        matches = this.findByName(name);
        // Exact names win, so a module such as "... II" is never mistaken for a skill level.
        if (!matches.length) {
          const suffix = /^(.*)\s+(i{1,3}|iv|v|[1-5])$/i.exec(name);
          if (suffix) {
            name = suffix[1] ?? "";
            level = /^\d$/.test(suffix[2] ?? "")
              ? Number(suffix[2])
              : ROMAN_LEVELS.indexOf(suffix[2]?.toUpperCase() as "I");
            matches = this.findByName(name);
          }
        }
        match = "exact-name";
        if (!matches.length) {
          matches = this.findByName(`${name}s`, true);
          match = "singular-skill-name";
        }
        if (!matches.length)
          return {
            status: "unresolved" as const,
            input: target,
            candidates: this.search(name),
            message:
              "Choose an exact published skill or ship; no target was inferred.",
          };
      } else {
        level = target.level;
        const type = this.getType(target.typeId);
        matches = type?.published ? [type] : [];
        if (!matches.length)
          return {
            status: "unresolved" as const,
            input: target,
            candidates: [],
            message:
              "No published skill or ship with this type ID exists in the cached SDE.",
          };
      }
      if (matches.length !== 1)
        return {
          status: "ambiguous" as const,
          input: target,
          candidates: matches.slice(0, SKILL_CANDIDATE_LIMIT).map((type) => ({
            typeId: type.id,
            name: type.name,
            categoryId: type.categoryId,
          })),
          ...(matches.length > SKILL_CANDIDATE_LIMIT
            ? { candidatesTruncated: true }
            : {}),
        };
      const type = matches[0];
      if (!type || ![6, 16].includes(type.categoryId))
        return {
          status: "unsupported" as const,
          input: target,
          message:
            "Select a skill or ship. Fit, rig, drone and module-use rules are outside this planner.",
        };
      if (type.requirements === null)
        throw new Error(`Missing requirement metadata for ${type.id}`);
      if (type.categoryId !== 16 && level !== undefined)
        throw new Error("Levels apply only to skill targets");
      const requirements =
        type.categoryId === 16
          ? [{ skillId: type.id, level: level ?? 1 }]
          : type.requirements;
      attributes({
        "eve.output.typeId": type.id,
        "eve.output.target_kind": type.categoryId === 16 ? "skill" : "ship",
        "eve.output.match": match,
        "eve.effective.level": type.categoryId === 16 ? (level ?? 1) : 0,
        "eve.output.requirement_count": requirements.length,
      });
      return {
        status: "resolved" as const,
        input: target,
        typeId: type.id,
        name: type.name,
        kind: type.categoryId === 16 ? "skill" : "ship",
        match,
        requirements,
      };
    });
  }
}

/** In-memory implementation for hosted projections, fixtures and full-artifact replay. */
export class SkillCatalog extends SkillReader {
  readonly types: Map<number, StaticType>;
  readonly metadata: SkillMetadata;
  private readonly names = new Map<string, StaticType[]>();
  constructor(readonly data: StaticCatalog) {
    super();
    this.data = validateCatalog(data);
    this.types = new Map(this.data.types.map((type) => [type.id, type]));
    const { types, ...metadata } = this.data;
    this.metadata = {
      ...metadata,
      typeCount: types.length,
      skillCount: types.filter(
        (type) => type.published && type.categoryId === 16,
      ).length,
    };
    for (const type of [...types].sort((a, b) => a.id - b.id)) {
      if (!type.published) continue;
      const key = type.name.toLowerCase();
      const matches = this.names.get(key) ?? [];
      matches.push(type);
      this.names.set(key, matches);
    }
  }
  override get diagnosticCatalog() {
    return this.data;
  }
  getType(id: number) {
    return this.types.get(typeId.parse(id));
  }
  findByName(name: string, skillsOnly = false) {
    return (this.names.get(name) ?? [])
      .filter((type) => !skillsOnly || type.categoryId === 16)
      .slice(0, SKILL_CANDIDATE_LIMIT + 1);
  }
  search(query: string) {
    z.string().max(600).parse(query);
    return withSpanSync("eve.search", () => {
      return [...this.types.values()]
        .filter(
          (type) =>
            type.published &&
            [6, 16].includes(type.categoryId) &&
            type.name.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, 20)
        .map((type) => ({
          typeId: type.id,
          name: type.name,
          categoryId: type.categoryId,
        }));
    });
  }
}
