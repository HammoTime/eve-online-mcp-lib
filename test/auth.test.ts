import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshTokenProvider, missingTokenScopes } from "../src/auth.js";

afterEach(() => vi.useRealTimers());

describe("portable token refresh", () => {
  it("deduplicates refreshes, verifies identity and persists rotation before returning", async () => {
    vi.useFakeTimers();
    const verify = vi
      .fn<(token: string) => Promise<void>>()
      .mockResolvedValue();
    const rotate = vi
      .fn<(token: string) => Promise<void>>()
      .mockResolvedValue();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          access_token: "test-access",
          expires_in: 120,
          refresh_token: "test-rotated",
        }),
      ),
    );
    const provider = new RefreshTokenProvider(
      "test-client",
      "test-refresh",
      undefined,
      fetcher,
      rotate,
      verify,
    );
    expect(
      await Promise.all([provider.getAccessToken(), provider.getAccessToken()]),
    ).toEqual(["test-access", "test-access"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("test-access");
    expect(rotate).toHaveBeenCalledWith("test-rotated");
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
      rotate.mock.invocationCallOrder[0] ?? 0,
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect((init?.body as URLSearchParams).toString()).toContain(
      "client_id=test-client",
    );
    await provider.getAccessToken();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await provider.getAccessToken();
    expect(
      (fetcher.mock.calls[1]?.[1]?.body as URLSearchParams).toString(),
    ).toContain("refresh_token=test-rotated");
  });

  it("encodes confidential-client credentials as UTF-8 with Web APIs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: "test-access", expires_in: 3600 }),
      );
    await new RefreshTokenProvider(
      "client",
      "test-refresh",
      "test-sëcret",
      fetcher,
    ).getAccessToken();
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Basic ${Buffer.from("client:test-sëcret").toString("base64")}`);
  });

  it.each(["verification", "storage"])(
    "withholds access tokens when %s fails",
    async (failure) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          Response.json({
            access_token: "test-access",
            expires_in: 3600,
            refresh_token: "test-new",
          }),
        ),
      );
      const fail = () => Promise.reject(new Error("unavailable"));
      const verify = failure === "verification" ? fail : undefined;
      const rotate = vi.fn(
        failure === "storage" ? fail : () => Promise.resolve(),
      );
      const provider = new RefreshTokenProvider(
        "test-client",
        "test-refresh",
        undefined,
        fetcher,
        rotate,
        verify,
      );
      await expect(provider.getAccessToken()).rejects.toThrow("unavailable");
      await expect(provider.getAccessToken()).rejects.toThrow("unavailable");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        (fetcher.mock.calls[1]?.[1]?.body as URLSearchParams).toString(),
      ).toContain("refresh_token=test-refresh");
      if (failure === "verification") expect(rotate).not.toHaveBeenCalled();
    },
  );

  it("keeps scope decoding advisory for opaque tokens and supports Unicode claims", () => {
    const token = `h.${Buffer.from(JSON.stringify({ name: "Pilöt", scp: ["read"] })).toString("base64url")}.s`;
    expect(missingTokenScopes(token, ["read", "missing"])).toEqual(["missing"]);
    expect(missingTokenScopes("opaque", ["read"])).toEqual([]);
  });
});
