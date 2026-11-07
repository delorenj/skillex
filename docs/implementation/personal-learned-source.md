# Personal learned source manager

`./scripts/personal-learned-source.py` owns the identity-bound Git checkpoint for named portable specialists. It intentionally does not activate skills globally, alter the project selection, or change Hermes writer configuration. Requires system Python with PyYAML and Git.

- `scripts/personal-learned-source.py migrate --profile /absolute/profile` previews admission without writes.
- `scripts/personal-learned-source.py migrate --profile /absolute/profile --apply` validates every learned file, copies the complete original tree (including category assets), verifies hashes, commits and pushes the identity subtree, then binds the profile to its Git source with an exact symlink and `.skillex-personal-source.json` receipt. It retains a verified recovery snapshot and the original whole tree outside discovery under `$XDG_STATE_HOME/skillex/personal-learning/<identity>/` (default `~/.local/state`). A failed commit/push leaves the original active tree intact and the source copy available for retry.
- `scripts/personal-learned-source.py check --profile /absolute/profile [--name proposed-skill]` is read-only prewrite admission. It validates identity, bound source, file types, selected/global names and advertised names; `--name` checks a proposed new skill before its creation.
- `scripts/personal-learned-source.py checkpoint --profile /absolute/profile` validates after writing and commits/pushes only `workforce/<identity>/learned-skills` and the identity's source registration (migration also stages its exact `agent.yaml` definition; never the ignored generated contract). Empty roots get `.gitkeep` so source ownership is durable. An isolated Git index preserves unrelated staged changes. A push failure returns nonzero and leaves the local commit and authored content available for retry.

All operations emit JSON `{ok,commit,pushed,error}`; refusal exits 3. The Hermes bridge installs `~/.local/bin/skillex-personal-checkpoint` as an executable symlink to this tracked script, invoking `check` before writing and `checkpoint` after writing. Migration must happen only after the runtime adapter and writer bridge are installed and verified.

Run focused tests with `python3 -m pytest -q tests/unit/test_personal_learned_inventory.py tests/unit/test_personal_learned_source.py`.
