import { attributes, diagnostic, withSpan } from "./telemetry.js";
import {
  EsiRequestError,
  publicEsiError,
  type EsiAuthorization,
  type EsiClient,
} from "./esi-client.js";
import type { OperationCatalog } from "./openapi.js";
import { sourceMetadata } from "./workflow-common.js";

export const CHARACTER_SECTIONS = {
  profile: "GetCharactersCharacterId",
  location: "GetCharactersCharacterIdLocation",
  ship: "GetCharactersCharacterIdShip",
  skills: "GetCharactersCharacterIdSkills",
  skillQueue: "GetCharactersCharacterIdSkillqueue",
  wallet: "GetCharactersCharacterIdWallet",
} as const;

export type CharacterSection = keyof typeof CHARACTER_SECTIONS;

const SKILLS_CAVEAT =
  "Completed skill-queue entries can precede updates to the skills endpoint until the character next logs in; this tool does not infer adjusted skill levels.";

function responseLimitError(limit: number): EsiRequestError {
  return new EsiRequestError(
    `Character context section exceeds the ${limit} byte aggregate result limit`,
    undefined,
    undefined,
    { code: "RESPONSE_LIMIT", retryable: false },
  );
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function getCharacterContext(
  client: EsiClient,
  catalog: OperationCatalog,
  input: { characterId: number; sections: CharacterSection[] },
  options: { maxResultBytes?: number } = {},
): Promise<Record<string, unknown>> {
  return withSpan(
    "eve.getCharacterContext",
    {
      "eve.input.sections": input.sections.filter(
        (s) => s in CHARACTER_SECTIONS,
      ),
      "eve.input.section_count": input.sections.length,
    },
    async () => {
      const maxResultBytes = options.maxResultBytes ?? 5_000_000;
      attributes({ "eve.limit.result_bytes": maxResultBytes });
      const caveats = input.sections.some(
        (section) => section === "skills" || section === "skillQueue",
      )
        ? [
            SKILLS_CAVEAT,
            "Each section is fetched separately; successful retrieval does not guarantee identical observation time or freshness.",
          ]
        : [
            "Each section is fetched separately; successful retrieval does not guarantee identical observation time or freshness.",
          ];
      const selected = input.sections.map((section) => ({
        section,
        operation: catalog.get(CHARACTER_SECTIONS[section]),
      }));
      const requiredScopes = [
        ...new Set(
          selected.flatMap(({ operation }) => operation.requiredScopes),
        ),
      ].sort();
      let authorization: EsiAuthorization | undefined;
      let authorizationError: unknown;
      let missingScopes: string[] = [];
      if (requiredScopes.length > 0) {
        try {
          authorization = await client.authorize(
            requiredScopes,
            input.characterId,
          );
        } catch (error) {
          authorizationError = error;
          const details =
            error instanceof EsiRequestError ? error.details : undefined;
          if (
            error instanceof EsiRequestError &&
            error.code === "MISSING_SCOPES" &&
            details !== null &&
            typeof details === "object" &&
            !Array.isArray(details) &&
            Array.isArray(details.missingScopes) &&
            details.missingScopes.every((scope) => typeof scope === "string")
          ) {
            const reported = details.missingScopes;
            missingScopes = requiredScopes.filter((scope) =>
              reported.includes(scope),
            );
            const availableScopes = [
              ...new Set(
                selected.flatMap(({ operation }) =>
                  operation.requiredScopes.some((scope) =>
                    missingScopes.includes(scope),
                  )
                    ? []
                    : operation.requiredScopes,
                ),
              ),
            ];
            // Retry only a strictly smaller, explicitly permitted scope set. A
            // consent refusal or unknown authentication failure never retries.
            if (missingScopes.length > 0 && availableScopes.length > 0) {
              try {
                authorization = await client.authorize(
                  availableScopes,
                  input.characterId,
                );
                authorizationError = undefined;
              } catch (retryError) {
                authorizationError = retryError;
              }
            }
          }
        }
      }

      const sections: Record<string, unknown> = {};
      let successes = 0;
      for (const { section, operation } of selected) {
        const sectionMissing = operation.requiredScopes.filter((scope) =>
          missingScopes.includes(scope),
        );
        diagnostic("eve.character.section.begin", {
          "eve.character.section": section,
          "eve.auth.required": operation.requiredScopes.length > 0,
          "eve.auth.failed":
            operation.requiredScopes.length > 0 &&
            (!!authorizationError || sectionMissing.length > 0),
        });
        if (
          operation.requiredScopes.length > 0 &&
          (authorizationError || sectionMissing.length)
        ) {
          sections[section] = {
            status: "error",
            error: publicEsiError(
              authorizationError ??
                new EsiRequestError(
                  "The EVE access token lacks required scopes",
                  403,
                  {
                    characterId: input.characterId,
                    missingScopes: sectionMissing,
                  },
                  { code: "MISSING_SCOPES", retryable: false },
                ),
            ),
          };
          continue;
        }
        try {
          const response = await withSpan(
            "eve.character.fetch_section",
            { "eve.character.section": section },
            () =>
              client.call(
                {
                  operationId: operation.operationId,
                  path: { character_id: input.characterId },
                },
                operation.requiredScopes.length > 0 ? authorization : undefined,
              ),
          );
          const sectionResult = {
            status: "ok",
            data: response.data,
            source: sourceMetadata(response),
          };
          const candidate = {
            characterId: input.characterId,
            requestedSections: input.sections,
            status: "complete",
            sections: { ...sections, [section]: sectionResult },
            atomic: false,
            caveats,
          };
          if (serializedBytes(candidate) > maxResultBytes) {
            sections[section] = {
              status: "error",
              error: publicEsiError(responseLimitError(maxResultBytes)),
            };
          } else {
            sections[section] = sectionResult;
            successes += 1;
          }
        } catch (error) {
          sections[section] = { status: "error", error: publicEsiError(error) };
        }
      }

      const buildResult = () => ({
        characterId: input.characterId,
        requestedSections: input.sections,
        status:
          successes === selected.length
            ? "complete"
            : successes === 0
              ? "failed"
              : "partial",
        sections,
        atomic: false,
        caveats,
      });
      let result = buildResult();
      for (const section of [...input.sections].reverse()) {
        if (serializedBytes(result) <= maxResultBytes) break;
        const sectionResult = sections[section];
        if (
          typeof sectionResult === "object" &&
          sectionResult !== null &&
          "status" in sectionResult &&
          sectionResult.status === "ok"
        ) {
          sections[section] = {
            status: "error",
            error: publicEsiError(responseLimitError(maxResultBytes)),
          };
          successes -= 1;
          result = buildResult();
        }
      }
      return result;
    },
  );
}
