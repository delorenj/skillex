# Deterministic BMAD materialization contract — SKRILL-27

Owner: skillex-pm. Operator authorized implementation of cross-project generative equivalence after the accepted SKRILL-26 freeze/activation.

## Domain and laws

Let S be a validated offline installation specification identifying BMAD version v, exact canonical catalog and composition inputs, explicit project configuration C, requested native client adapters, and required runtime support. A version label alone is not S. Let M(S, O, p) reconcile observed initial state O at project root p.

For equivalent initial managed states and the same S/C, changing project identity/root or unrelated foreign content must not change normalized managed output:

    N(M(S, O_x, P[x])) = N(M(S, O_y, P[y]))

N removes only declared root relocation and truly volatile receipt metadata. It includes every managed payload byte, mode, resolved canonical target identity, declared membership, support dependency, and client mapping. It must not erase missing runtime, drift, extra managed files, errors, or wrong versions. Foreign state is compared separately byte-for-byte, with link targets and types retained.

Other laws:

- Idempotence: second successful reconcile has zero managed changes and identical observed managed state.
- Dry-run: same validation and proposed decisions as apply; zero target writes.
- Preservation: foreign/edited content survives unchanged, or entire operation refuses before writes. Location, matching basename, and matching bytes alone do not confer ownership.
- Pin integrity: same version label plus changed pinned inputs refuses, rather than producing a different installation.
- Explicit dependencies: required missing runtime is an actionable dependency failure before writes; partial legacy freeze evidence is not a complete installation input.
- No hidden environmental inputs: roots, registry, state directory, configuration, client set and inheritance policy are explicit or captured in S. Do not silently consult mutable global skill selection as an installation input.

The universal claim is conditional on available validated pinned inputs and equivalent C/O. Finite generated tests are evidence of these laws, not a proof for every filesystem or future version.

## Implementation boundaries

- One real skill definition remains in all-skills. Project .agents/skills contains references; native client roots alias it. Sets/packs never contain real SKILL.md bodies. ADR-0001 applies.
- Pin the catalog and composition, not a new sealed per-skill checksum inventory. Content verification may bind the specification to exact source inputs without creating duplicate versioned skill payloads.
- Runtime support is declared separately and may be materialized as support assets, never disguised copied canonical skill definitions. No guessed/fabricated missing runtime, no network resolution at apply time, no LLM installation choices.
- Reuse existing manifest parser, canonical resolver, planner, writer locks and receipt ownership whenever possible. Avoid a parallel activation writer. All collision preflight must complete before manifest, runtime or activation changes.
- Existing foreign _bmad/config/client dirs require explicit preservation/refusal, not adoption. Project-specific config is an explicit input and is not normalized away.
- Multiple supplied version inputs are supported; no arbitrary historical version download is promised. Existing one-resident canonical-version restriction remains explicit and guarded.
- Scope of initial execution: temporary fixture projects and registries only. No commit/push/publishing/package installation; no changes to IdealScenario, live global selection, other Hermes profiles, or active catalog payloads.

## Acceptance evidence

1. Public CLI/API produces a validated versioned specification and desired-state graph; materializer applies it to real isolated projects.
2. Seeded generative CLI tests cover at least two distinct version/content inputs, three distinct roots/layouts, more than one native client combination, equivalent starting states, unrelated files, missing owned artifacts, foreign collisions, authored edits, malformed pins/specs and required missing dependencies.
3. Test oracle independently walks actual output (bytes/types/modes/links/membership/runtime/client mapping); it does not compare the planner to itself or trust success envelopes alone. Explicit expected fixtures challenge shared wrong results.
4. Any counterexample prints seed/case and leaves reproducible evidence. Bad-pin and collision tests check entire-tree equality dry-run/apply.
5. Full npm check and independent spec then quality gates. Existing freeze, global selection and ownership regressions remain passing.
6. Actual pruned IdealScenario source is exercised read-only, with truthful completeness/dependency outcome. Synthetic fixtures prove generic mechanics only and are labelled as such.

## Consequential call

Build LEGO, Not Statues and Dogfood the Platform drive extracting the desired-state seam now: repeated project-specific repairs demonstrated the second occurrence. The slice remains bounded to BMAD as the first real adapter; a speculative universal installer framework is out of scope.
