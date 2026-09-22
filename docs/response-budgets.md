# Model-facing response budgets

MCP presentation is bounded separately from ESI transport and planner computation.
Core success bodies have a 24,000 UTF-8 JSON byte ceiling; selected data has an
8,000 byte ceiling and at most 25 entries per slice. Multi-section character
context uses 2,500 data bytes per successful section. The text fallback is compact
JSON, equivalent to `structuredContent`, retained for client compatibility. Wire
bytes include both representations and escaping; these limits are not token counts.

The ESI client still retrieves one complete upstream operation/page within its
existing transport limit. The planner still validates the full dependency graph,
complete skills/queue evidence and queue replay before presentation. Budgeting never
turns missing permissions, failed sections or omitted rows into facts.

## Reading a bounded response

`output` accompanies the selected data:

- `path` identifies the selected JSON member, using an array of exact property
  names or decimal array indices. The empty path selects the root.
- `kind`, `total`, `returned` and `offset` describe the selected array, object,
  string or scalar. Strings count Unicode code points; object offsets count keys.
- `complete` is true only when the whole selected value appears in this response.
  It does not establish upstream completeness or coverage of the entire root.
- `nextOffset` continues the selected collection/string. A null value means no
  further sequential slice, but `omitted` members may still require retrieval.
- `omitted` describes oversized members with their paths, kinds and counts. No
  placeholder null is substituted. An oversized array row can produce an empty
  **partial** slice; its path retrieves that row, while nextOffset moves past it.
- `snapshot` binds the original JSON evidence and execution identity. It is a
  change detector, not a stored snapshot, credential, authorization or grant.

Repeat the same tool and original inputs. For another slice, set `response.path`
to `output.path`, `response.offset` to `output.nextOffset`, and `response.snapshot`
to `output.snapshot`. For omitted details, use the omitted path, offset zero and
the same snapshot. Keep the original path/query/body/header inputs unchanged.
Every call reauthorizes and fetches (or uses its credential-isolated cache) before
checking the digest. Changed evidence returns an error: restart from offset zero
without a snapshot, and discard the old slices. No server-side private result
store is introduced, so continuation also works across stateless hosted requests.

`call_esi` returns the verified `actingCharacterId` for protected calls. Retain it
on continuations, including requests that initially used a session default. An
explicit character path already binds identity. Protected upstream `pagination.nextCall`
also pins the verified identity. Finish the current page's local slices and omitted
members before following upstream pagination; these are separate dimensions.

For example, after a character-skills response omits its `skills` array:

```json
{
  "characterId": 42,
  "sections": ["skills"],
  "response": {
    "path": ["skills"],
    "offset": 0,
    "snapshot": "<copy sections.skills.output.snapshot>"
  }
}
```

Use exactly one section for character detail selection. Each successful section
retains source metadata and its own output metadata; section failures stay visible.
Context `status` describes section fetch success, not presentation completeness.

## Tool contract changes

`generate_skill_plan` returns totals, counts, queue policy, target resolution,
source evidence and caveats, with compact plan rows in `data` by default. These
retain observed trained, observed active and conditional baseline levels and the
planner's SP estimate. Repeated graph keys and prerequisites are omitted from rows.
Other views use response.path:

| Path                    | Evidence                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `["plan"]`              | Ordered training rows (default)                             |
| `["graph", "nodes"]`    | Full prerequisite node details in bounded slices            |
| `["graph", "edges"]`    | Prerequisite-to-dependent edges                             |
| `["retainedQueue"]`     | Observed queue entries, including optional timing/SP fields |
| `["trainingText"]`      | Exact import text, chunked by bytes if necessary            |
| `["acquisitionChecks"]` | Skillbook/injection checks                                  |

Keep the same snapshot across views. Concatenate string chunks without inserting
separators. Do not offer an importable list until all text chunks are retrieved;
label additions versus replacement using `trainingTextKind`. A computation status
of complete does not mean every row was included in the current presentation.
`get_skill_dependencies` returns bounded graph data with the same selection rules.

`resolve_skill_plan_targets`, `resolve_eve_entities` and `list_eve_characters` retain
their `targets`, `results` and `characters` field names, paired with `output`.
Those fields contain the selected value when response.path requests a member.
Character lists default to scope counts; `includeScopes: true` retrieves the
scope-bearing view, which can itself be paged. Authorize/select responses also use
compact character status; retrieve details with list rather than repeating consent.

Search defaults to 10 candidates, maximum 25. Candidates contain operation ID,
summary, authentication requirement and match reasons. Detailed parameters,
scopes, cache policy and schemas remain in `get_esi_operation`.

All tools retain object-root output schemas. Dynamic detail data uses JSON-valued
contracts; selection, counts, source evidence and completeness remain typed.
Character sections share one record-value schema instead of six repeated schemas.
The SDK's public Standard Schema interface emits reused definitions as local
JSON Schema references, while retaining the original Zod runtime validator.
The contract tests cover legacy 2025-03-26, 2025-11-25 and modern 2026-07-28 MCP
serialization. They do not establish any host's model context accounting.

Maps default to `preview: "none"`; request `preview: "png"` explicitly for an
inline preview. Modern clients receive the original SVG resource link. Older
protocols retain the existing embedded SVG fallback and its separate map limits.
Map images, artifact reads and resources have their own limits; the core JSON
budget does not claim to measure client image token costs.

The two similarly named EVE integrations mentioned in the review are client
configuration, not two tool registrations in this server. Choosing one connection
requires the owner's intent and access to that configuration; no connections are
disabled by these library changes.
