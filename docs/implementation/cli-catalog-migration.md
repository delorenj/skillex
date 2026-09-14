# SKRILL-18: Canonical catalog conversion

The 2026-09-14 source conversion used the Node `migrate` command and the explicit
[historical mapping](../plan/cli-migration-map.json). This is the catalog part of
[SKRILL-18](https://plane.delo.sh/33god/projects/5aa8ec5c-3c66-49f9-b900-cca8a8446b65/issues/f29575b7-2222-471a-a336-19b14cf15821).
Activation and installed-consumer cutover remain SKRILL-20.

## Result

- 216 existing real canonical definitions were retained; 116 definitions were
  imported from embedded sets, the Hermes base pack, and external collections.
- The resulting catalog has 332 real definitions, seven reference-only sets,
  and six valid packs. Hidden legacy containers were expanded into explicit
  membership. No real skill definition remains owned by a set or pack.
- Kurzgesagt became `kurzgesagt`; its stale `skill-creator` member was removed
  by the user's explicit choice. The independent system creator definition was
  imported normally. No historical creator variant was restored.
- Existing differing definitions remain distinct. Qualified names include
  `hermes-base-0-18-2-computer-use`, `hermes-base-0-18-2-design-md`, and
  `hyperframes-upstream-hyperframes`.
- The Cloudflare and ProductManager set wrappers became
  `cloudflare-focused-hub` and `product-manager-hub`, owning only their skill
  entrypoints. Their child routes now point to canonical sibling definitions.
- Prepared upstream declarations were onboarded. The existing `ego-browser`
  provenance gained its missing `ego-lite` source binding; the recorded
  `v1.2.3` version, adaptation flag, notes, and content were retained. The
  upstream Git tree confirms `skills/ego-browser` at that tag.

The new `0.1.0` versions for the formerly unversioned Kurzgesagt and torrent
packs are authored migration versions. They are not reconstructed release tags.

## Content evidence

A before/after inventory compared 4,321 filesystem nodes across all 332
canonical destinations: file SHA-256, entry kinds, link text, and executable
bits. After removing independently generated, ignored Python bytecode, the
initial import comparison found zero differences. All 733 imported authored
files are committed, including the two n8n environment examples containing
literal secret-generation placeholders.

Three authored corrections preceded the import: sibling routes in the two
wrapper entrypoints, and a folded YAML description in `n8n-code-tool` to preserve
its colon-containing text. After import, four new canonical entrypoints gained
unique frontmatter names: the Cloudflare hub and the three qualified variants
listed above. Their bodies and support files were unchanged. This avoids
Hermes's duplicate frontmatter-name and command-name collisions. Other unique
frontmatter aliases remain supported.

The existing `ego-browser/.source.yaml` gained only `origin.source: ego-lite`.
Existing canonical skill content and recorded upstream pins were not refreshed.
The skills submodule conversion is commit
`e9f0406bd6044e5c9b0bcbbcb00e1558bd16282e`.

## Verification

The explicit apply returned exit 0 with 131 applied operations and verified
migration receipts in XDG state. The final source-only doctor returned exit 0
with no findings: 332 skills, seven sets, six packs, 168 provenance records, and
18 recorded digests checked. Each pack passed `pack verify`:

- `folder-curator`
- `hermes-base@0.18.2`
- `hindsight-maintenance`
- `kurzgesagt`
- `product-manager`
- `torrent-movie`

A subsequent registry-only `migrate --apply` with no historical input mapping
returned exit 0 and an empty applied list. The historical mapping deliberately
requests imports from their original sources; reusing it after authoring changes
to an imported definition correctly refuses that differing destination. Existing
canonical content is the authority after conversion.

Offline `vendor status` still reports five existing differences between the
Pjangler declaration's selected revision and individual recorded versions. It
also preserves `ego-browser`'s local-modification warning and incomplete legacy
digest evidence. These are explicit upstream-update concerns, not topology
exceptions; this migration neither discards local adaptations nor rewrites pins
to make them look current.

Tooling commit `4c394f8c9cd0fabac78b99ac97b0b5b393405759` passed all four
[Node 24/26 Ubuntu/macOS jobs](https://github.com/delorenj/skillex/actions/runs/34877154024).
The case-only pack rename regression covers interrupted publication, recovery,
and preservation of a distinct pre-existing destination. Local Node acceptance
passed 844 tests with one existing UID-dependent skip, including 100 migration
checks. Retained Python checks are updated for the deliberate removal of the
three-engine flattening contract and legacy alias names; they do not define the
new Node composition contract.

## Boundaries

This source conversion did not select a global/project activation target or
Hermes profile. The installed Python launcher, active checkout wiring, service
removal, and profile ownership handoff are tracked in SKRILL-20. Python runtime
and obsolete documentation removal are tracked in SKRILL-21.
