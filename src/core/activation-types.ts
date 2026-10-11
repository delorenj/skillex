export interface EntryIdentity {
  readonly kind: "directory" | "link";
  readonly dev: string;
  readonly ino: string;
  readonly raw?: string;
}

export interface OwnedNode {
  readonly identity: EntryIdentity;
  readonly children?: Readonly<Record<string, EntryIdentity>>;
}

export interface SourceRevision {
  /** Legacy receipts recorded "pack" for whole-root pack sources; they stay readable. */
  readonly kind: "catalog" | "pack" | "set";
  readonly path: string;
  readonly commit: string | null;
  readonly reason: string | null;
}

export interface ActivationJournal {
  readonly id: string;
  readonly intent: string;
  readonly path: string;
  readonly stage: string;
  readonly parked: string;
  readonly previous?: OwnedNode;
  readonly next?: OwnedNode;
}

export interface ActivationData {
  readonly version: 1;
  readonly links: Readonly<Record<string, EntryIdentity>>;
  readonly directories: Readonly<Record<string, EntryIdentity>>;
  readonly sources: readonly SourceRevision[];
  readonly pending?: ActivationJournal;
}
