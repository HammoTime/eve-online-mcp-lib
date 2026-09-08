import { decodeJwt } from "jose";

export const DEFAULT_EVE_CLIENT_ID = "6a65f1e650d240659dafbad29fb55e05";

export interface TokenProvider {
  getAccessToken(
    requiredScopes?: string[],
    characterId?: number,
  ): Promise<string | undefined>;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly code:
      "CHARACTER_MISMATCH" | "CHARACTER_SELECTION_REQUIRED" | "MISSING_SCOPES",
    readonly details: {
      characterId?: number;
      authenticatedCharacterId?: number;
      missingScopes?: string[];
    } = {},
  ) {
    super(message);
  }
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string | undefined) {}

  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.token);
  }
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class RefreshTokenProvider implements TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private currentRefreshToken: string;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly clientId: string,
    refreshToken: string,
    private readonly clientSecret: string | undefined,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly onRefreshToken?: (
      refreshToken: string,
    ) => Promise<void> | void,
    private readonly verifyAccessToken?: (token: string) => Promise<void>,
  ) {
    this.currentRefreshToken = refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return this.cached.token;

    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.currentRefreshToken,
    });
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
    });
    if (this.clientSecret) {
      headers.set(
        "authorization",
        `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${this.clientId}:${this.clientSecret}`)))}`,
      );
    } else {
      body.set("client_id", this.clientId);
    }

    const response = await this.fetchImplementation(
      "https://login.eveonline.com/v2/oauth/token",
      {
        method: "POST",
        headers,
        body,
      },
    );
    if (!response.ok)
      throw new Error(
        `EVE SSO token refresh failed with HTTP ${response.status}`,
      );
    const value = (await response.json()) as RefreshResponse;
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      (value.refresh_token !== undefined &&
        (typeof value.refresh_token !== "string" || !value.refresh_token))
    )
      throw new Error("EVE SSO returned an invalid token response");
    await this.verifyAccessToken?.(value.access_token);
    if (
      value.refresh_token &&
      value.refresh_token !== this.currentRefreshToken
    ) {
      await this.onRefreshToken?.(value.refresh_token);
      this.currentRefreshToken = value.refresh_token;
    }
    this.cached = {
      token: value.access_token,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
    return value.access_token;
  }
}

export function missingTokenScopes(
  token: string,
  requiredScopes: string[],
): string[] {
  if (requiredScopes.length === 0) return [];
  const payload = token.split(".")[1];
  if (!payload) return [];
  try {
    const decoded = decodeJwt(token) as { scp?: string | string[] };
    if (!decoded.scp) return [];
    const granted = new Set(
      Array.isArray(decoded.scp) ? decoded.scp : decoded.scp.split(" "),
    );
    return requiredScopes.filter((scope) => !granted.has(scope));
  } catch {
    return [];
  }
}
