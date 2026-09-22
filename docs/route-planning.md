# Server-owned route and skill planning

## Authority and workflow

The assistant selects user goals and constraints and explains returned evidence.
Only MCP implementations expand dependencies, account for progress, optimize stop
order, concatenate paths, compute totals, and draw maps. Tool failure is not
permission to implement a substitute in prose, Python, JavaScript, or another
renderer. Revised requirements must be submitted to the tools again.

`plan_eve_route` accepts exact system names/IDs for origin, destination, required
stops, excluded systems, and an optional **raw SDE** minimum-security threshold.
Use the same origin and destination for a pickup loop. `stopOrder=optimize` finds
the minimum-jump walk visiting every required stop; `as_given` preserves the
requested stop sequence. This is permanent-stargate routing, not live navigation,
wormhole mapping, cyno routing, cargo-capacity planning, or a safety assessment.
No user-supplied connections or arbitrary graph weights are accepted.

The public cached SDE supplies a bounded compact directed graph. Breadth-first
search produces shortest paths from the relevant terminals. The exact Held–Karp
subset dynamic program minimizes the sum of these directed distances. Repeated
transit systems remain in the walk. Duplicate pickup systems are collapsed for optimized ordering on the
server; direction is never inferred by reversing a path. Stable numeric ordering
breaks ties. An independent replay checks every edge, exclusion, threshold, stop,
endpoint, leg boundary, and jump total before publication.

Bounds are 12 pickup stops, 20,000 graph systems, 50,000 connection pairs, and 250
route visits. Larger requests fail explicitly, without trimming or approximate
results labelled optimal. Complexity is O(k(V+E) + k²2^k) time and O(kV + k2^k)
working memory. Ordered stops omit subset optimization. Exact optimality is
relative to the complete selected SDE snapshot and stated constraints, never a
claim about transient gates, live risks, or all possible modes of travel.

## Persistence and rendering

A plan is persisted as an optional versioned record in the existing private map
artifact envelope. Its opaque artifact ID is the route ID. The existing local
filesystem/R2 integrity, expiry, owner isolation, admission, and retention rules
apply. Hosted storage remains scoped to verified environment + user + OAuth
client, with fresh authorization at storage checkpoints. No module-global route
registry, new public URL, binding, migration, or credential is needed.

`render_eve_map({routeId, preview:"png"})` reads that stored plan. Raw nonempty
route arrays are rejected at the MCP boundary. Context maps retain explicit
boundaries and caller-selected annotations, without route overlays. Internal
rendering APIs continue to accept validated ordered paths for planner use/tests.

Geographic/atlas rendering may use the current geometry only if its source
identity matches the plan. Dense, oversized-for-atlas, or changed-snapshot maps
fall back to numbered itinerary pages rendered entirely by the MCP. Each page
contains at most 25 consecutive visits, with one overlapping boundary visit on
the next page so every jump is visible. Page indices, total pages, continuation,
global visit numbers, and total jumps come from the server. Rendering never
changes or reoptimizes the plan. The full plan is preserved even if a PNG preview
fails. Missing/expired route IDs require replanning; callers cannot supply a
replacement path under the old ID.

## Host integration and privacy

Local SQLite reads graph rows inside one transaction. Hosted D1 reads one sealed
immutable projection using a first-primary session, fixed projection identity,
bounded rows/bytes, and completeness counts. This explicit planning workload
reads the compact graph; ordinary scoped map rendering retains its existing
query path and never loads the universe. No per-system ESI discovery is needed.

Both planning and rendering use the hosted map admission/rate-limit boundary.
Route names, stop arrays, paths, handles, and annotations remain excluded from
custom telemetry and diagnostic captures. Only the closed tool-name enum grows.

Skill planning retains ancestor closure + Kahn topological sorting and independent
replay. Submit all targets together; never merge separately generated plans,
subtract progress, reorder training text, or calculate missing totals in the
assistant. Missing evidence remains an explicit failure, not zero progress.

## Acceptance

Tests cover directed/disconnected graphs, exact optimizer agreement with an
independent small brute-force oracle, shared transit/duplicate stops, stable ties,
constraints, cancellation, bounds, publication completeness, route-handle expiry
and ownership, raw-path rejection, dense-map fallback, page continuity, and
closed diagnostics. The seven-stop pickup-loop failure is represented with
synthetic public fixtures, not private historical asset exports.

Library and both consumer validation gates must pass. Source integration remains
uncommitted until a validated library commit is authorized and available remotely;
consumer gitlinks must then select that exact reviewed commit before release.
