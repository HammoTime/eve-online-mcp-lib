/** Session-bound adapter. Never return credentials through MCP. */
export interface CharacterAuthentication {
  list(): Promise<{
    characters: {
      characterId: number;
      characterName: string;
      scopes: string[];
    }[];
    defaultCharacterId: number | null;
    legacyCredentialPendingMigration: boolean;
    browserAuthorizationAvailable: boolean;
  }>;
  authorize(characterId: number): Promise<
    | Awaited<ReturnType<CharacterAuthentication["list"]>>
    | {
        status: "authorization_required";
        authorizationUrl: string;
        characterId: number;
        message: string;
      }
  >;
  select(characterId: number): ReturnType<CharacterAuthentication["list"]>;
}
