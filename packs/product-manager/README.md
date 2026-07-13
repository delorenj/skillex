# ProductManager Pack

Feature-candidate discovery agent plus four phase skills:

- `product-manager-agent`
- `product-manager-research-phase`
- `product-manager-brainstorm-phase`
- `product-manager-feature-doc-phase`
- `product-manager-report-phase`

## Activate

Preview without touching live CLI roots:

```bash
skillex pack activate product-manager --scope project --dry-run
```

Activate in the current repo:

```bash
skillex pack activate product-manager --scope project
```

Global activation also works, but it replaces the current global skillex pack's
managed links. Use a dry-run first.

## Runner Targets

Activation publishes the agent and phase skills to:

| Runner | Target |
|---|---|
| Claude | `.claude/skills/<skill>` or `~/.claude/skills/<skill>` |
| Codex | `.codex/prompts/<skill>.md` or `~/.codex/prompts/<skill>.md` |
| Kimi | `.kimi-code/skills/<skill>` or `~/.kimi-code/skills/<skill>` |
| Gemini | `.gemini/skills/<skill>` or `~/.gemini/config/skills/<skill>` |
| Hermes | `.hermes/skills/<skill>` or `~/.hermes/skills/<skill>` |
| OpenCode | `.agents/agent/<skill>.md` or `~/.config/opencode/agent/<skill>.md` |

## Start Prompt

Use this with any runner after activation:

```text
Invoke ProductManager. Run a feature-candidate discovery pass for this repo.
Start with ResearchPhase, then BrainstormPhase, then FeatureDocPhase for the
top candidate, then ReportPhase. Save artifacts under docs/product-manager/.
```
