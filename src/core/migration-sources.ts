import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { readBoundReceipt, writeBoundReceipt } from "./activation-state.js";
import { withCatalogLock } from "./catalog-lock.js";
import { discoverRegistry } from "./discovery.js";
import { fail } from "./error.js";
import { inspectPath } from "./filesystem.js";
import {
  checkMigrationSignal,
  migrationFailure,
  normalizeMigrationOptions,
} from "./migration-common.js";
import type { MigrationItem, MigrationOptions, MigrationSectionResult } from "./migration-types.js";
import { ExitCode, makeResult, type ResultEnvelope } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import { readVendorProvenance } from "./vendor-provenance.js";
import { normalizeVendorRepo, parseVendorSourcesText, readVendorText } from "./vendor-sources.js";

const binding = { namespace: "migrations", targetParts: ["all-skills", "sources.toml"] } as const;
const prefix = ".skillex-tmp-migrate-sources-";
interface SourceReceipt {
  readonly version: 1;
  readonly source: string;
  readonly digest: string;
  readonly phase: "pending" | "verified";
  readonly stage: string;
  readonly dev: string;
  readonly ino: string;
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function refused(path: string, message: string): never {
  fail(
    "E_MIGRATION_SOURCES",
    message,
    {
      path,
      fix: "Preserve the named files and correct the prepared source declaration or migration receipt before retrying.",
    },
    ExitCode.REFUSED,
  );
}

async function validateProvenance(
  registry: RegistrySelection,
  text: string,
  path: string,
): Promise<void> {
  const sources = parseVendorSourcesText(text, path);
  const catalog = join(registry.root, "all-skills");
  for (const name of (await readdir(catalog)).sort()) {
    const skill = join(catalog, name);
    if (!(await inspectPath(skill))?.isDirectory() || !(await inspectPath(join(skill, "SKILL.md"))))
      continue;
    const receipt = await readVendorProvenance(skill);
    if (!receipt?.source) continue;
    const source = sources.find((entry) => entry.name === receipt.source);
    if (
      !source ||
      (receipt.upstream &&
        normalizeVendorRepo(receipt.upstream) !== normalizeVendorRepo(source.repo))
    )
      refused(
        path,
        `Prepared declarations do not preserve the recorded upstream identity for ${name}.`,
      );
  }
}

/** Explicit declaration onboarding preserves all recorded skill bytes and upstream pins. */
export async function migrateSources(
  input: MigrationOptions,
): Promise<ResultEnvelope<MigrationSectionResult | null>> {
  let data: MigrationSectionResult = { items: [], applied: [], receipts: [] };
  let publication: { path: string; record: SourceReceipt; id: string } | undefined;
  try {
    const options = normalizeMigrationOptions(input);
    checkMigrationSignal(options);
    const registry = await discoverRegistry(options);
    const catalog = join(registry.root, "all-skills");
    const destination = join(catalog, "sources.toml");
    const source = options.sourcesFile ?? join(registry.root, "docs", "vendoring", "sources.toml");
    const receiptOptions = { ...options, forbiddenRoots: [registry.root, source] };
    const run = async (
      apply: boolean,
      expected?: MigrationItem,
    ): Promise<ResultEnvelope<MigrationSectionResult | null>> => {
      data = { items: [], applied: [], receipts: [] };
      checkMigrationSignal(options);
      let snapshot = await readBoundReceipt<SourceReceipt>(registry.root, binding, receiptOptions);
      const old = snapshot.document?.data;
      if (
        old &&
        (old.version !== 1 ||
          typeof old.source !== "string" ||
          typeof old.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(old.digest) ||
          !["pending", "verified"].includes(old.phase) ||
          typeof old.stage !== "string" ||
          basename(old.stage) !== old.stage ||
          !new RegExp(`^${prefix}[a-f0-9-]{36}$`).test(old.stage) ||
          !/^\d+$/.test(old.dev) ||
          !/^\d+$/.test(old.ino))
      )
        refused(snapshot.path, "The source migration receipt is malformed.");
      const artifacts = (await readdir(catalog)).filter((name) => name.startsWith(prefix));
      const unknown = artifacts.filter((name) => name !== old?.stage || old.phase !== "pending");
      if (unknown.length)
        return makeResult("migrate sources", data, {
          exit: ExitCode.PARTIAL,
          findings: unknown.map((name) => ({
            code: "W_MIGRATION_RECOVERY_PRESERVED",
            severity: "warning",
            path: join(catalog, name),
            message: "Unrecorded source staging is preserved.",
            fix: "Account for this exact artifact before retrying migration.",
          })),
        });
      const existing = await readVendorText(destination, "E_SOURCES_MANIFEST_INVALID");
      if (old?.phase === "pending") {
        const item: MigrationItem = {
          id: `sources:${destination}`,
          area: "sources",
          action: "recover-source-declaration",
          path: destination,
          target: old.source,
          state: "ready",
          afterDigest: old.digest,
          details: ["Resume only the exact recorded source publication."],
          dependsOn: [],
        };
        data = { items: [item], applied: [], receipts: [snapshot.path] };
        if (!apply)
          return makeResult("migrate sources", data, {
            exit: ExitCode.PARTIAL,
            findings: [
              {
                code: "W_MIGRATION_PENDING",
                severity: "warning",
                path: snapshot.path,
                message: "Source declaration recovery is pending.",
                fix: "Run migrate --apply to resume the recorded publication.",
              },
            ],
          });
        const stage = join(catalog, old.stage);
        publication = { path: destination, record: old, id: item.id };
        const matches = async (path: string) => {
          const info = await inspectPath(path);
          return (
            info?.isFile() &&
            String(info.dev) === old.dev &&
            String(info.ino) === old.ino &&
            hash((await readVendorText(path, "E_MIGRATION_SOURCES")) ?? "") === old.digest
          );
        };
        if (existing !== null && !(await matches(destination)))
          refused(
            destination,
            "The destination differs from the recorded interrupted publication.",
          );
        if (existing === null) {
          if (!(await matches(stage)))
            refused(
              stage,
              "The recorded source staging no longer matches its identity and digest.",
            );
          const stagedText = await readVendorText(stage, "E_MIGRATION_SOURCES");
          const currentSource = await readVendorText(old.source, "E_MIGRATION_SOURCES");
          if (currentSource !== null && hash(currentSource) !== old.digest)
            refused(
              old.source,
              "The prepared declaration changed during interruption; preserve the staged plan for explicit inspection.",
            );
          await validateProvenance(registry, stagedText ?? "", stage);
          checkMigrationSignal(options);
          await link(stage, destination);
          data = { ...data, applied: [item.id] };
        }
        if (await inspectPath(stage)) {
          if (!(await matches(stage))) refused(stage, "Preserve the replaced source staging file.");
          await unlink(stage);
        }
        snapshot = await writeBoundReceipt(snapshot, { ...old, phase: "verified" }, receiptOptions);
        data = { ...data, items: [{ ...item, state: "verified" }], receipts: [snapshot.path] };
        return makeResult("migrate sources", data);
      }
      const prepared =
        existing === null || options.sourcesFile !== undefined
          ? await readVendorText(source, "E_SOURCES_MANIFEST_INVALID")
          : null;
      if (existing !== null) {
        await validateProvenance(registry, existing, destination);
        if (options.sourcesFile !== undefined && prepared !== existing)
          refused(
            destination,
            "A different source declaration already exists; migration never overwrites it.",
          );
        data = {
          items: [
            {
              id: `sources:${destination}`,
              area: "sources",
              action: "verify-source-declaration",
              path: destination,
              state: "verified",
              afterDigest: hash(existing),
              details: [
                "Existing declaration and recorded upstream identities are valid; skill pins and content are unchanged.",
              ],
              dependsOn: [],
            },
          ],
          applied: [],
          receipts: old?.phase === "verified" ? [snapshot.path] : [],
        };
        return makeResult("migrate sources", data);
      }
      if (old) refused(destination, "A previously verified source declaration has been removed.");
      if (prepared === null) {
        // A local-only fixture or catalog needs no upstream declaration.
        await validateProvenance(registry, "version = 1\n", source);
        if (options.sourcesFile !== undefined)
          refused(source, "The explicitly selected prepared declaration does not exist.");
        return makeResult("migrate sources", data);
      }
      await validateProvenance(registry, prepared, source);
      const digest = hash(prepared);
      if (expected?.beforeDigest && expected.beforeDigest !== digest)
        refused(source, "The prepared declaration changed while migration waited for its lock.");
      const item: MigrationItem = {
        id: `sources:${destination}`,
        area: "sources",
        action: "onboard-source-declaration",
        path: source,
        target: destination,
        state: "ready",
        beforeDigest: digest,
        afterDigest: digest,
        details: [
          "Copy the validated declaration; preserve every catalog definition and recorded upstream pin.",
        ],
        dependsOn: [],
      };
      data = { items: [item], applied: [], receipts: [] };
      if (!apply) return makeResult("migrate sources", data);
      const stageName = `${prefix}${randomUUID()}`;
      const stage = join(catalog, stageName);
      const handle = await open(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      let owned: Awaited<ReturnType<typeof handle.stat>>;
      try {
        await handle.writeFile(prepared);
        await handle.sync();
        owned = await handle.stat();
      } finally {
        await handle.close();
      }
      const record: SourceReceipt = {
        version: 1,
        source,
        digest,
        phase: "pending",
        stage: stageName,
        dev: String(owned.dev),
        ino: String(owned.ino),
      };
      snapshot = await writeBoundReceipt(snapshot, record, receiptOptions);
      publication = { path: destination, record, id: item.id };
      data = { ...data, receipts: [snapshot.path] };
      checkMigrationSignal(options);
      if ((await readVendorText(source, "E_SOURCES_MANIFEST_INVALID")) !== prepared)
        refused(source, "Prepared source content changed after migration planning.");
      await validateProvenance(registry, prepared, source);
      await link(stage, destination);
      data = { ...data, applied: [item.id] };
      await unlink(stage);
      const directory = await open(
        catalog,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      snapshot = await writeBoundReceipt(
        snapshot,
        { ...record, phase: "verified" },
        receiptOptions,
      );
      data = { ...data, items: [{ ...item, state: "verified" }], receipts: [snapshot.path] };
      return makeResult("migrate sources", data);
    };
    const preview = await run(false);
    const ready = preview.data?.items.find((item) => item.state === "ready");
    if (
      !options.apply ||
      !ready ||
      (preview.exit !== ExitCode.SUCCESS &&
        !preview.findings.some((finding) => finding.code === "W_MIGRATION_PENDING"))
    )
      return preview;
    return await withCatalogLock(registry, options, () => run(true, ready));
  } catch (error) {
    if (publication && !data.applied.includes(publication.id)) {
      try {
        const info = await inspectPath(publication.path);
        if (
          info?.isFile() &&
          String(info.dev) === publication.record.dev &&
          String(info.ino) === publication.record.ino &&
          hash((await readVendorText(publication.path, "E_MIGRATION_SOURCES")) ?? "") ===
            publication.record.digest
        )
          data = { ...data, applied: [...data.applied, publication.id] };
      } catch {
        /* Preserve the original error and journal when inspection is unavailable. */
      }
    }
    const failure = migrationFailure("migrate sources", error, data);
    return publication && failure.exit !== ExitCode.INTERRUPTED
      ? makeResult("migrate sources", data, { exit: ExitCode.PARTIAL, findings: failure.findings })
      : failure;
  }
}
