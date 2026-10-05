# BMAD 6.12.1-next.1 durable runtime support

Finite, non-canonical pack-level support asset (ADR-0001). Vendored from the
authentic installer output at freeze time so the pack carries a repeatable
runtime prerequisite with NO dependency on the temporary freeze source root.

- Source: authentic `bmad-method-installer` output for 6.12.1-next.1
  (installation `_config/manifest.yaml` pinned below; module matrix includes
  bmb v2.2.2 sha 4a1422274a2acb0fb0ec0511753da6263948f072,
  cis v0.3.2 sha 97298b22fee1c7e482710d3a8414adb5cfccccd9,
  bmad-loop main sha 68645cbd3e1a8aa2d7d3b2e69a5f2bee834e8ae3).
- Contents: `_config/` metadata + manifests, `scripts/`, `core/`, `bmm/`,
  `bmb/`, `cis/`, `bmad-loop/`, `render/` module config/help assets
  (23 files total).
- Excluded by design: `config.user.toml` (user/team install answers),
  `custom/`, `_memory/`, caches — user/team state is NEVER vendored. The
  neutral default `config.toml` IS included verbatim (upstream installation
  provenance; see inventory below); a consuming project replaces
  `core.project_name` with its own identity, as IdealScenario did.
- No SKILL.md or skill-owned child is vendored here (canonical bodies live in
  all-skills/ via the freeze receipts).
- Provenance: this runtime snapshot was captured verbatim by
  `skillex bmad freeze` from the authentic installer output — files are not
  hand-edited afterward. `pack.toml` remains the authored contract baseline
  and is unchanged by this note.

File inventory (path, sha256):
- _config/bmad-help.csv  968e6c1d764980da87571c3b5e9cceafedde647b10d31cd89be9241b86ef652c
- _config/files-manifest.csv  074586581aa324fa4a2f45b46b0eb11d3a20c48af85b8ce8de17367d78711296
- _config/manifest.yaml  70df9f57bd2d0248a5322ff804b415652a02c47224f84cb369cbb808f2506f5d
- _config/skill-manifest.csv  f2c8b62eb63fe4196c404acc67e38ce0afa5d47f1c5042a505b2cf21940b83bc
- bmad-loop/config.yaml  db5e9f80ab11d3c6dd7803a8f70c442e6b92dba5b70af367d6f721d1ef6ba823
- bmad-loop/module-help.csv  7052d30125407ba930b15eefb12d05a55f6768b0a31ee14863844a685ee4c61a
- bmb/config.yaml  2b4e5362dfb94703f4893e033a3b0ede0f5d5f8cfe44ad6f1e2927373f8e301d
- bmb/module-help.csv  fe5c030134a6019d6a8c9e609ca6c196cd5f469aac8b9711145257a966f14b7e
- bmm/config.yaml  0874efaa1e31cb0e15909270eb6ce952aacac1f048614d89cb95d90c45d7b781
- bmm/module-help.csv  c3c1033c8fffef924bb71342e22a0a2a8243911a0b856e2aa7804d8bb49feb5a
- bmm/v6-shims/README.md  5495469425b50bca1cd74899c6ebfe840f137cf2a68d008bc993aa2574bd9972
- cis/config.yaml  40fb801e1cc637f6a79e4ef64f911215f94b3933fdc3fc8d3ccc5fd777bd5587
- cis/module-help.csv  0c02169aee8d548ee7b190c16551dc681df217c55b8fffff5fc8ada017f2270f
- config.toml  0f8e120e064d3480fa6b9e7d60b7316d79bd1b76d6386f8caf384b2f87367ffc
- core/config.yaml  53d62ee251cca85320f112fda6247a95c9a55d208d041e819f71ce0fcfd26962
- core/module-help.csv  38846d71f87159345d6a6256a170c142fb3f53d9cf9c258c9ee6f26bd88a86c7
- core/v6-shims/README.md  017900bb03baeddc0262041a6aa85bce744e8c45991dcde32ef042f9bc2a32b2
- render/.gitignore  240a3e0d37d2e86b614063f5347eb02d4f99ca6c254de6b82871ff8d95532a7d
- scripts/config_utils.py  48afe2bc18a29201e343cce3703be1e70df9c83ee74eeb68e57ef8ef42e8c651
- scripts/memlog.py  3b00f82ca33dc4227f715123b939514ee35c4f9c71150c894c3d8185df1b48df
- scripts/render_skill.py  8496d0d8b449d64c21b42a9aab3b13fc8a813a430c0695ffd84ad75bb1da7942
- scripts/resolve_config.py  70d7577396ed40ab9462ab75dce51f852bc2e094b2d1a054214f1b30c8789768
- scripts/resolve_customization.py  c95aab9f2dc500d6ab7db77d6a7860028701ce414e03690613a282cc3659d284
