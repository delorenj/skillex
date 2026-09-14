import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { validateActivationStateLocation } from "./activation-state.js";
import { fail } from "./error.js";
import { type LockOptions, withLock } from "./lock.js";
import { ExitCode } from "./result.js";
import type { RegistrySelection } from "./selection.js";
import { assertNoVendorJournal } from "./vendor-state.js";

export interface CatalogLockOptions extends LockOptions {
  readonly signal?: { readonly aborted: boolean };
}

interface CatalogTransactionOptions extends CatalogLockOptions {
  readonly allowPendingVendor?: boolean;
}

function interrupted(options: CatalogLockOptions): void {
  if (options.signal?.aborted) {
    fail(
      "E_INTERRUPTED",
      "Catalog operation interrupted.",
      {
        fix: "Inspect the result and retry the explicit catalog command when ready.",
      },
      ExitCode.INTERRUPTED,
    );
  }
}

/** Share state-placement rules without reading or writing an activation receipt. */
export async function validateCatalogStateLocation(
  registry: RegistrySelection,
  options: CatalogLockOptions,
): Promise<void> {
  await validateActivationStateLocation(registry.root, {
    ...options,
    forbiddenRoots: [registry.root],
  });
}

/** All Node writers of canonical definition bytes serialize on the catalog itself. */
export async function withCatalogLock<T>(
  registry: RegistrySelection,
  options: CatalogTransactionOptions,
  action: () => Promise<T>,
): Promise<T> {
  interrupted(options);
  const catalog = join(registry.root, "all-skills");
  const initial = await lstat(catalog);
  const path = await realpath(catalog);
  const assertCatalog = async () => {
    const current = await lstat(catalog);
    if (
      !initial.isDirectory() ||
      !current.isDirectory() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      (await realpath(catalog)) !== path
    ) {
      fail(
        "E_CATALOG_CHANGED",
        "The canonical catalog directory changed during the operation.",
        {
          path: catalog,
          fix: "Inspect the selected catalog and retry after other writers finish.",
        },
        ExitCode.REFUSED,
      );
    }
  };
  await assertCatalog();
  await validateCatalogStateLocation(registry, options);
  if (!options.allowPendingVendor) await assertNoVendorJournal(registry, options);
  return withLock(
    `${path}#catalog`,
    async () => {
      interrupted(options);
      await assertCatalog();
      await validateCatalogStateLocation(registry, options);
      if (!options.allowPendingVendor) await assertNoVendorJournal(registry, options);
      const result = await action();
      await assertCatalog();
      return result;
    },
    options,
  );
}
