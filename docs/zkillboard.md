# Public zKillboard killmails

`search_zkillmails` searches one public upstream page for a resolved entity:

```json
{
  "entityType": "solarSystem",
  "entityId": 30000142,
  "side": "all",
  "pastSeconds": 86400,
  "page": 1
}
```

Resolve names with `resolve_eve_entities` first. Entity types are `character`,
`corporation`, `alliance`, `faction`, `shipType`, `group`, `solarSystem`,
`constellation`, `region`, `location`, and `war`. Optional filters include `side`
(`all`, `kills`, `losses`), `solo`, `space` (`highsec`, `lowsec`, `nullsec`,
`w-space`, `abyssal`) and `pastSeconds` (one-hour increments up to seven days).
Pages range from 1 to 100. All URL segments come from validated IDs and enums;
callers cannot supply URLs, headers, methods or arbitrary query parameters.

`get_zkillmail` accepts `{"killmailId":123456789}` and returns one public record.
A missing record is an error and may reflect publication delay or incomplete
coverage. These tools never submit killmails or request EVE credentials. Hosted
MCP transport authentication still applies.

Both tools use [model response budgets](response-budgets.md). `data` contains
bounded JSON; `output` identifies omitted members and snapshot-checked slices.
For example, select `response.path:["attackers"]` on a single killmail to inspect
its attackers. Repeat the original inputs and use `output.nextOffset` and
`output.snapshot` for continuation. Finish slices before advancing
`pagination.nextPage`; different upstream pages are not an atomic snapshot.

`complete:false` always describes the incomplete combat history. A full 200-row
page has `pagination.hasMore:null`, because another page is possible, not proven.
`output.complete` describes only the selected JSON value. An empty result is not
proof of no activity. No result establishes live intelligence or system safety.

The implementation follows the [current zKillboard API documentation](https://zkillboard.com/api/docs/):
full killmails with `zkb` metadata, at most 200 per page, a minimum five-minute
publication delay and a one-hour client cache. The historical GitHub wiki describes
older behavior and is not the implementation contract.

The public-only default client is shared within one runtime/isolate, independent
of all EVE credentials and MCP users. Hosts may inject `options.zkillboard` with a
`ZKillboardClient`. It holds at most 16 cache entries / 8 MB of serialized bodies,
limits each streamed body to 2 MB, and uses a 30-second deadline. Identical requests
share one download with at most 64 waiters; other concurrent requests and requests
less than a second apart return a retryable throttle. Upstream Retry-After is
honored without automatic retries. Cancellation of a waiter does not cancel a
shared download; the wire deadline still bounds abandoned work. These are per
instance limits, not a distributed account/IP-wide limiter. Cache hits return
isolated copies with fetch/expiry timestamps. Redirects are rejected, errors are
sanitized, and malformed/error bodies are never treated as empty pages.

Killmail bodies, hashes and character IDs are not added to diagnostic capture or
telemetry allowlists. Diagnostic replay of these tools is marked unsupported.
