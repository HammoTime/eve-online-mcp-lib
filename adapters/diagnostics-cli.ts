import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  realpath,
  stat,
  lstat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { replayDiagnostic, replaySchema } from "./replay.js";
import { replaySynthetic } from "./synthetic-replay.js";
import type { OpenApiDocument } from "../src/types.js";
import { staticCatalogSchema, type StaticCatalog } from "../src/skill-data.js";

async function readBounded(file: string, limit: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit)
    throw new Error("Invalid or oversized diagnostic file");
  return readFile(file);
}

const [command, ...args] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    "trace-id": { type: "string" },
    out: { type: "string" },
    env: { type: "string" },
    from: { type: "string" },
    synthetic: { type: "string" },
  },
});
const schemaPath = new URL("../openapi/esi-openapi.json", import.meta.url);
if (command === "export") {
  const id = values["trace-id"];
  if (!id || !/^[a-f0-9]{32}$/u.test(id) || !values.out)
    throw new Error("Specify --trace-id (32 hex characters) and --out");
  const out = resolve(values.out);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const file = join(out, "manifest.json");
  if (values.from) {
    const source = join(await realpath(values.from), `${id}.json`);
    if (!(await stat(source)).isFile())
      throw new Error("Expected a diagnostic file");
    await copyFile(source, file);
  } else {
    if (!["dev", "prod"].includes(values.env ?? ""))
      throw new Error("Select --env dev or --env prod");
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "get",
        `eve-diagnostics-${values.env}/traces/${id}/manifest.json`,
        "--remote",
        "--file",
        file,
      ],
      { stdio: "inherit" },
    );
  }
  const bytes = await readBounded(file, 1024 * 1024);
  if (bytes.byteLength > 1024 * 1024)
    throw new Error("Diagnostic manifest is oversized");
  const manifest = replaySchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.traceId !== id) throw new Error("Trace ID mismatch");
  for (const artifact of [
    ...manifest.catalogs,
    ...manifest.dependencies.flatMap((d) =>
      d.bodyArtifact ? [d.bodyArtifact] : [],
    ),
  ]) {
    const file = join(out, `${artifact.sha256}.json`);
    if (values.from)
      await copyFile(join(await realpath(values.from), artifact.key), file);
    else
      execFileSync(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "get",
          `eve-diagnostics-${values.env}/${artifact.key}`,
          "--remote",
          "--file",
          file,
        ],
        { stdio: "inherit" },
      );
    if (
      createHash("sha256")
        .update(await readBounded(file, 8 * 1024 * 1024))
        .digest("hex") !== artifact.sha256
    )
      throw new Error("Catalog artifact digest mismatch");
  }
  const schema = await readFile(schemaPath);
  if (
    createHash("sha256").update(schema).digest("hex") !==
    manifest.versions.openapi
  )
    throw new Error(
      "Check out the captured library revision before export; the OpenAPI digest differs",
    );
  await writeFile(join(out, "esi-openapi.json"), schema, { mode: 0o600 });
  await writeFile(
    join(out, "manifest.sha256"),
    createHash("sha256").update(bytes).digest("hex"),
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      event: "diagnostics.exported",
      traceId: id,
      status: manifest.status,
      reasons: manifest.reasons,
    }),
  );
} else if (command === "replay") {
  if (values.synthetic) {
    globalThis.fetch = () => {
      throw new Error("Network is disabled during replay");
    };
    const result = await replaySynthetic(
      values.synthetic,
      JSON.parse(await readFile(schemaPath, "utf8")) as OpenApiDocument,
    );
    console.error(JSON.stringify(result));
    process.exit(0);
  }
  const supplied = positionals[0];
  if (positionals.length !== 1 || !supplied)
    throw new Error("Specify the path to manifest.json");
  const file = await realpath(supplied);
  const directory = resolve(file, "..");
  const bytes = await readBounded(file, 1024 * 1024);
  if (bytes.byteLength > 1024 * 1024)
    throw new Error("Diagnostic manifest is oversized");
  const expectedDigest = (
    await readFile(join(directory, "manifest.sha256"), "utf8")
  ).trim();
  if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest)
    throw new Error("Manifest digest mismatch");
  const manifest = replaySchema.parse(JSON.parse(bytes.toString("utf8")));
  const schema = await readBounded(
    join(directory, "esi-openapi.json"),
    16 * 1024 * 1024,
  );
  if (
    createHash("sha256").update(schema).digest("hex") !==
    manifest.versions.openapi
  )
    throw new Error("OpenAPI digest mismatch");
  const revision = execFileSync(
    "git",
    ["-C", fileURLToPath(new URL("..", import.meta.url)), "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (manifest.versions.library !== revision)
    throw new Error("Check out the captured library revision before replay");
  if (
    execFileSync(
      "git",
      [
        "-C",
        fileURLToPath(new URL("..", import.meta.url)),
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        "src",
        "adapters",
        "package.json",
        "package-lock.json",
      ],
      { encoding: "utf8" },
    ).trim()
  )
    throw new Error(
      "Replay requires the captured library's unchanged source and dependency lockfile",
    );
  globalThis.fetch = () => {
    throw new Error("Network is disabled during replay");
  };
  const catalogs = new Map<string, StaticCatalog>();
  const bodies = new Map<string, string>();
  for (const artifact of manifest.catalogs) {
    const bytes = await readBounded(
      join(directory, `${artifact.sha256}.json`),
      8 * 1024 * 1024,
    );
    if (
      bytes.byteLength > 8 * 1024 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error("Catalog artifact digest mismatch");
    catalogs.set(
      artifact.sha256,
      staticCatalogSchema.parse(JSON.parse(bytes.toString("utf8"))),
    );
  }
  let bodyBytes = 0;
  for (const dependency of manifest.dependencies) {
    const artifact = dependency.bodyArtifact;
    if (!artifact) continue;
    const bytes = await readBounded(
      join(directory, `${artifact.sha256}.json`),
      8 * 1024 * 1024,
    );
    bodyBytes += bytes.byteLength;
    if (
      bodyBytes > 8 * 1024 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error("Dependency artifact digest mismatch");
    bodies.set(artifact.sha256, bytes.toString("utf8"));
  }
  const result = await replayDiagnostic(
    manifest,
    JSON.parse(schema.toString("utf8")) as OpenApiDocument,
    catalogs,
    bodies,
  );
  await writeFile(
    join(directory, "replay-result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      event: "diagnostics.reproduced",
      dependencyCalls: result.dependencyCalls,
      boundary: result.boundary,
    }),
  );
} else throw new Error("Expected export or replay");
