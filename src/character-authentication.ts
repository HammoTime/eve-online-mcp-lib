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
  authorize(characterId: number): ReturnType<CharacterAuthentication["list"]>;
  select(characterId: number): ReturnType<CharacterAuthentication["list"]>;
}
