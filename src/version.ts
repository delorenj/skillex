import { readFileSync } from "node:fs";

// Both source modules and bundled entrypoints live one directory below the
// package metadata. This stays correct after an isolated tarball installation.
const metadata: { version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const VERSION: string = metadata.version;
