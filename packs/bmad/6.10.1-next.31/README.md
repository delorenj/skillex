# BMAD 6.10.1-next.31 skill pack

Immutable, manifest-attested agent-skill payload rendered by
`bmad-method@6.10.1-next.31`. It contains 76 skills and 1072
files. Project repositories should link their agent skill directories to these
top-level `bmad-*` directories; they should not copy or edit this payload.

Rebuild or verify it from the original BMAD installation:

```bash
python scripts/build_bmad_pack.py SOURCE_PROJECT 6.10.1-next.31
python scripts/build_bmad_pack.py --check SOURCE_PROJECT 6.10.1-next.31
```

`SHA256SUMS` covers every payload and metadata file except itself.
