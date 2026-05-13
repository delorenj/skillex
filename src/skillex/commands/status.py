"""skillex status: show active packs and per-CLI sync state."""

from __future__ import annotations

import http.server
import os
import socketserver
import threading
import time
import webbrowser
from collections import defaultdict
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from skillex.core.activator import _skillex_owned_links_in
from skillex.core.loader import load_config
from skillex.core.models import SkillexConfig
from skillex.paths import default_config_path, find_project_root, load_project_scope_pack

console = Console()


def _shallowest_symlink(path: Path) -> Path | None:
    """Return the shallowest path component (root-first) that is a symlink, or None.

    Used to enumerate intermediate hops one at a time, so multi-level chains
    (e.g. `.claude/skills` → `.agents/skills` → `skill-sets/global`) render
    each step instead of collapsing to the final realpath.
    """
    components: list[Path] = [*list(path.parents)[::-1], path]
    for p in components:
        try:
            if p.is_symlink():
                return p
        except OSError:
            continue
    return None


def _trace(start: Path) -> list[Path]:
    """Trace `start` through symlink hops, resolving the shallowest symlink each step."""
    chain: list[Path] = [start]
    seen: set[str] = set()
    current = start
    for _ in range(64):
        key = os.path.normpath(str(current))
        if key in seen:
            break
        seen.add(key)
        sym = _shallowest_symlink(current)
        if sym is None:
            break
        try:
            raw = Path(os.readlink(sym))
        except OSError:
            break
        target = raw if raw.is_absolute() else (sym.parent / raw)
        try:
            suffix = current.relative_to(sym)
        except ValueError:
            suffix = Path(".")
        if str(suffix) in ("", "."):
            new_path = Path(os.path.normpath(str(target)))
        else:
            new_path = Path(os.path.normpath(str(target / suffix)))
        chain.append(new_path)
        current = new_path
    return chain


def _pretty(p: Path, home: Path) -> str:
    """Shorten paths under $HOME to `~/...` for display."""
    try:
        rel = p.relative_to(home)
        return "~" if str(rel) == "." else "~/" + str(rel)
    except ValueError:
        return str(p)


def _gather(cfg: SkillexConfig) -> dict[str, Any]:
    """Collect all data needed to render either terminal or HTML status."""
    home = Path.home()
    enabled = [name for name, c in cfg.cli_adapters.items() if c.enabled]

    skill_subdirs: dict[str, Path] = {}
    resolved: dict[str, Path] = {}
    is_link: dict[str, bool] = {}
    chains: dict[str, list[Path]] = {}
    managed_counts: dict[str, int] = {}
    for name, adapter_cfg in cfg.cli_adapters.items():
        sub = adapter_cfg.global_root / "skills"
        skill_subdirs[name] = sub
        is_link[name] = sub.is_symlink()
        try:
            resolved[name] = sub.resolve(strict=False)
        except OSError:
            resolved[name] = sub
        chains[name] = _trace(sub)
        managed_counts[name] = len(
            _skillex_owned_links_in(adapter_cfg.global_root, cfg.skills_root)
        )

    canonical: Path | None = None
    if enabled:
        counts: dict[Path, int] = defaultdict(int)
        for n in enabled:
            counts[resolved[n]] += 1
        canonical = max(counts.items(), key=lambda kv: kv[1])[0]

    origin_cli: str | None = None
    for name in enabled:
        if not is_link[name] and resolved[name] == canonical and skill_subdirs[name].is_dir():
            origin_cli = name
            break

    return {
        "home": home,
        "enabled": enabled,
        "skill_subdirs": skill_subdirs,
        "resolved": resolved,
        "is_link": is_link,
        "chains": chains,
        "managed_counts": managed_counts,
        "canonical": canonical,
        "origin_cli": origin_cli,
    }


def _render_terminal(cfg: SkillexConfig, data: dict[str, Any], project_root: Path | None) -> None:
    home = data["home"]

    scope_table = Table(title="Active Packs")
    scope_table.add_column("scope")
    scope_table.add_column("pack")

    global_pack = cfg.scopes.get("global")
    scope_table.add_row(
        "global",
        global_pack.active_pack if global_pack and global_pack.active_pack else "(none)",
    )
    if project_root is not None:
        project_pack = load_project_scope_pack(project_root)
        scope_table.add_row(f"project ({project_root})", project_pack or "(none)")
    else:
        scope_table.add_row("project", "(not in a project)")
    console.print(scope_table)

    cli_table = Table(title="CLI Roots")
    cli_table.add_column("", width=2)
    cli_table.add_column("cli")
    cli_table.add_column("enabled")
    cli_table.add_column("global_root")
    cli_table.add_column("skills/")
    cli_table.add_column("links", justify="right")
    for name, adapter_cfg in cfg.cli_adapters.items():
        sub = data["skill_subdirs"][name]
        if sub.is_symlink():
            try:
                skills_display = f"→ {_pretty(Path(os.readlink(sub)), home)}"
            except OSError:
                skills_display = "[red](unreadable)[/red]"
        elif sub.is_dir():
            skills_display = "[bold]directory[/bold]"
        else:
            skills_display = "[dim](missing)[/dim]"
        is_origin = name == data["origin_cli"]
        cli_table.add_row(
            "[bold green]✓[/bold green]" if is_origin else "",
            name,
            "yes" if adapter_cfg.enabled else "no",
            str(adapter_cfg.global_root),
            skills_display,
            str(data["managed_counts"][name]),
            style="bold" if is_origin else None,
        )
    console.print(cli_table)

    canonical = data["canonical"]
    skills_root = cfg.skills_root
    if data["origin_cli"]:
        console.print(
            f"[green]→ Add new skills under[/green] "
            f"[bold]{_pretty(skills_root, home)}/[/bold]; "
            f"[dim]CLI[/dim] [bold]{data['origin_cli']}[/bold] [dim]is the canonical link target.[/dim]"
        )
    elif canonical is not None:
        console.print(
            f"[green]→ Add new skills under[/green] "
            f"[bold]{_pretty(skills_root, home)}/[/bold] "
            f"[dim](routed via[/dim] [bold]{_pretty(canonical, home)}/[/bold][dim]).[/dim]"
        )
    console.print("[dim]Run [bold]skillex status --html[/bold] for a topology graph.[/dim]")


def _build_mermaid(cfg: SkillexConfig, data: dict[str, Any]) -> str:
    home = data["home"]

    def label(p: Path) -> str:
        return _pretty(p, home)

    node_id: dict[str, str] = {}

    def nid(p: Path) -> str:
        key = os.path.normpath(str(p))
        if key not in node_id:
            node_id[key] = f"n{len(node_id)}"
        return node_id[key]

    lines = ["flowchart LR"]
    declared: set[str] = set()
    edges: set[tuple[str, str]] = set()
    missing: list[tuple[str, Path]] = []

    for name in data["enabled"]:
        sub = data["skill_subdirs"][name]
        chain = data["chains"][name]
        if not sub.is_symlink() and not sub.is_dir():
            missing.append((name, sub))
            continue
        start = chain[0]
        n_start = nid(start)
        if n_start not in declared:
            count = data["managed_counts"].get(name, 0)
            count_str = f"<br/><i>{count} skills</i>" if count else ""
            lines.append(f'    {n_start}["<b>{name}</b><br/>{label(start)}{count_str}"]:::cli')
            declared.add(n_start)
        for i in range(len(chain) - 1):
            edges.add((nid(chain[i]), nid(chain[i + 1])))
        for j, p in enumerate(chain[1:], start=1):
            n = nid(p)
            if n in declared:
                continue
            if j == len(chain) - 1:
                lines.append(f'    {n}(["{label(p)}<br/><b>canonical</b>"]):::canonical')
            else:
                lines.append(f'    {n}["{label(p)}"]:::hop')
            declared.add(n)

    canonical = data["canonical"]
    skills_root = cfg.skills_root
    if canonical is not None:
        sr_resolved = skills_root.resolve()
        canon_resolved = canonical.resolve()
        sr_node = nid(skills_root)
        if sr_node not in declared:
            lines.append(
                f'    {sr_node}[/"📦 {label(skills_root)}<br/><b>origin · all-skills</b>"/]:::origin'
            )
            declared.add(sr_node)
        if canon_resolved != sr_resolved:
            edges.add((nid(canonical), sr_node))
        else:
            # canonical IS skills_root — re-style that single node as origin (no extra edge)
            pass

    for a, b in edges:
        # per-skill link from canonical to skills_root: render dotted
        is_canonical_edge = canonical is not None and a == nid(canonical) and b == nid(skills_root)
        arrow = "-. per-skill .->" if is_canonical_edge else "-->"
        lines.append(f"    {a} {arrow} {b}")

    for name, sub in missing:
        n = nid(sub)
        lines.append(f'    {n}["<b>{name}</b><br/>{label(sub)}<br/><i>no skills/</i>"]:::missing')
        declared.add(n)

    lines += [
        "    classDef cli fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a",
        "    classDef hop fill:#f3f4f6,stroke:#6b7280,color:#374151",
        "    classDef canonical fill:#fef3c7,stroke:#d97706,color:#92400e",
        "    classDef origin fill:#bbf7d0,stroke:#15803d,stroke-width:3px,color:#14532d",
        "    classDef missing fill:#fee2e2,stroke:#dc2626,color:#991b1b,stroke-dasharray:5 5",
    ]
    return "\n".join(lines)


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>skillex status</title>
<style>
  :root {
    --bg: #fafafa; --panel: #fff; --ink: #18181b; --muted: #71717a;
    --border: #e4e4e7;
    --green: #16a34a; --green-bg: #ecfdf5; --green-border: #86efac;
    --amber: #d97706; --amber-bg: #fffbeb;
    --red: #dc2626; --red-bg: #fef2f2;
    --blue: #2563eb; --blue-bg: #eff6ff;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
    background: var(--bg); color: var(--ink);
    margin: 0; padding: 32px 16px; line-height: 1.5;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .subtle { color: var(--muted); font-size: 0.85rem; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 22px 26px; margin: 18px 0; }
  section h2 { margin: 0 0 14px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .origin-card { background: linear-gradient(160deg, #ecfdf5 0%, #d1fae5 100%); border: 1px solid var(--green-border); }
  .origin-card .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.1em; color: #15803d; font-weight: 700; }
  .origin-card .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.35rem; font-weight: 600; margin: 8px 0 6px; word-break: break-all; color: #064e3b; }
  .origin-card .desc { color: #166534; font-size: 0.92rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--border); font-size: 0.93rem; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); background: #fafafa; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr.is-origin td { background: var(--green-bg); }
  tr.is-origin td:first-child { border-left: 3px solid var(--green); }
  td code, .desc code { font-family: ui-monospace, monospace; font-size: 0.85rem; background: #f4f4f5; padding: 2px 6px; border-radius: 4px; }
  .badge { display: inline-block; font-size: 0.72rem; padding: 2px 9px; border-radius: 999px; font-weight: 600; letter-spacing: 0.02em; }
  .badge.ok { background: var(--green-bg); color: var(--green); }
  .badge.warn { background: var(--amber-bg); color: var(--amber); }
  .badge.err { background: var(--red-bg); color: var(--red); }
  .badge.muted { background: #f4f4f5; color: var(--muted); }
  .badge.origin { background: var(--green); color: #fff; }
  .mermaid { display: flex; justify-content: center; min-height: 220px; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; font-size: 0.82rem; color: var(--muted); }
  .legend .chip { display: inline-flex; align-items: center; gap: 6px; }
  .legend .swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid currentColor; }
  footer { color: var(--muted); font-size: 0.78rem; text-align: center; margin-top: 28px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>skillex status</h1>
  <div class="subtle">Generated __TIMESTAMP__ &middot; config: <code>__CONFIG_PATH__</code></div>

__ORIGIN_CARD__

  <section>
    <h2>Routing topology</h2>
    <div class="mermaid">
__MERMAID_SRC__
    </div>
    <div class="legend">
      <span class="chip"><span class="swatch" style="background:#dbeafe;border-color:#1d4ed8"></span> CLI root</span>
      <span class="chip"><span class="swatch" style="background:#f3f4f6;border-color:#6b7280"></span> hop</span>
      <span class="chip"><span class="swatch" style="background:#fef3c7;border-color:#d97706"></span> canonical</span>
      <span class="chip"><span class="swatch" style="background:#bbf7d0;border-color:#15803d"></span> origin (add here)</span>
      <span class="chip"><span class="swatch" style="background:#fee2e2;border-color:#dc2626"></span> missing</span>
    </div>
  </section>

  <section>
    <h2>CLI roots</h2>
    <table>__CLI_TABLE__</table>
  </section>

  <section>
    <h2>Active packs</h2>
    <table>__PACK_TABLE__</table>
  </section>

  <footer>skillex &middot; skills_root <code>__SKILLS_ROOT__</code> &middot; packs_root <code>__PACKS_ROOT__</code></footer>
</div>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({
    startOnLoad: true,
    theme: 'base',
    themeVariables: { fontSize: '13px', fontFamily: 'ui-sans-serif, system-ui, sans-serif' },
    flowchart: { curve: 'basis', nodeSpacing: 50, rankSpacing: 90, padding: 10 },
  });
</script>
</body>
</html>
"""


def _render_html(
    cfg: SkillexConfig, data: dict[str, Any], project_root: Path | None, config_path: Path
) -> str:
    home = data["home"]
    origin_cli = data["origin_cli"]
    canonical = data["canonical"]

    # Origin card
    skills_root_pretty = escape(_pretty(cfg.skills_root, home))
    if origin_cli:
        desc = (
            f"All CLI <code>skills/</code> directories link through "
            f"<b>{escape(origin_cli)}</b>, which terminates at this directory."
        )
    elif canonical is not None and canonical.resolve() != cfg.skills_root.resolve():
        desc = (
            f"All enabled CLIs route through "
            f"<code>{escape(_pretty(canonical, home))}/</code>, "
            f"then per-skill symlinks land here."
        )
    else:
        desc = "All CLI routes terminate here."

    origin_card = (
        '<section class="origin-card">\n'
        '  <div class="label">📍 Add new skills here</div>\n'
        f'  <div class="path">{skills_root_pretty}/&lt;your-skill&gt;/</div>\n'
        f'  <div class="desc">{desc}</div>\n'
        "</section>"
    )

    # CLI table
    cli_rows = [
        "<thead><tr>"
        "<th>cli</th><th>status</th><th>global_root</th>"
        "<th>skills/</th><th>links</th>"
        "</tr></thead><tbody>"
    ]
    for name, adapter_cfg in cfg.cli_adapters.items():
        sub = adapter_cfg.global_root / "skills"
        if not adapter_cfg.enabled:
            status_badge = '<span class="badge muted">disabled</span>'
            skills_cell = '<span class="badge muted">—</span>'
        elif sub.is_symlink():
            try:
                tgt = _pretty(Path(os.readlink(sub)), home)
                skills_cell = f"→ <code>{escape(tgt)}</code>"
                status_badge = '<span class="badge ok">linked</span>'
            except OSError:
                skills_cell = '<span class="badge err">unreadable</span>'
                status_badge = '<span class="badge err">error</span>'
        elif sub.is_dir():
            skills_cell = '<span class="badge origin">directory</span>'
            status_badge = '<span class="badge ok">canonical</span>'
        else:
            skills_cell = '<span class="badge muted">no skills/</span>'
            status_badge = '<span class="badge warn">not linked</span>'

        is_origin = name == origin_cli
        tr_cls = ' class="is-origin"' if is_origin else ""
        marker = "✓ " if is_origin else ""
        cli_rows.append(
            f"<tr{tr_cls}>"
            f"<td>{marker}<b>{escape(name)}</b></td>"
            f"<td>{status_badge}</td>"
            f"<td><code>{escape(str(adapter_cfg.global_root))}</code></td>"
            f"<td>{skills_cell}</td>"
            f"<td>{data['managed_counts'].get(name, 0)}</td>"
            "</tr>"
        )
    cli_rows.append("</tbody>")
    cli_table = "\n".join(cli_rows)

    # Active pack table
    pack_rows = ["<thead><tr><th>scope</th><th>active pack</th></tr></thead><tbody>"]
    global_pack = cfg.scopes.get("global")
    g_val = global_pack.active_pack if global_pack and global_pack.active_pack else None
    pack_rows.append(
        f"<tr><td>global</td><td>{f'<code>{escape(g_val)}</code>' if g_val else '<span class="badge muted">none</span>'}</td></tr>"
    )
    if project_root is not None:
        project_pack = load_project_scope_pack(project_root)
        p_val = project_pack or None
        pack_rows.append(
            f"<tr><td>project<br><span class='subtle'>{escape(str(project_root))}</span></td>"
            f"<td>{f'<code>{escape(p_val)}</code>' if p_val else '<span class="badge muted">none</span>'}</td></tr>"
        )
    else:
        pack_rows.append(
            "<tr><td>project</td><td><span class='badge muted'>not in a project</span></td></tr>"
        )
    pack_rows.append("</tbody>")
    pack_table = "\n".join(pack_rows)

    mermaid_src = _build_mermaid(cfg, data)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    return (
        _HTML_TEMPLATE.replace("__TIMESTAMP__", ts)
        .replace("__CONFIG_PATH__", escape(str(config_path)))
        .replace("__ORIGIN_CARD__", origin_card)
        .replace("__MERMAID_SRC__", mermaid_src)
        .replace("__CLI_TABLE__", cli_table)
        .replace("__PACK_TABLE__", pack_table)
        .replace("__SKILLS_ROOT__", escape(str(cfg.skills_root)))
        .replace("__PACKS_ROOT__", escape(str(cfg.packs_root)))
    )


def _serve_html(html_text: str, port: int) -> tuple[str, socketserver.TCPServer]:
    """Spin up a localhost HTTP server that returns html_text for GET /."""
    payload = html_text.encode("utf-8")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = socketserver.TCPServer(("127.0.0.1", port), Handler)
    actual_port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{actual_port}/", server


def register(app: typer.Typer) -> None:
    @app.command("status")
    def status_cmd(
        config_path: Path = typer.Option(default_config_path(), "--config"),
        html: bool = typer.Option(
            False, "--html", help="Serve an HTML topology report at http://localhost and open it."
        ),
        html_out: Path | None = typer.Option(
            None, "--html-out", help="Write the HTML report to this path instead of serving."
        ),
        port: int = typer.Option(
            0, "--port", help="Port for the HTML server (0 = pick a free port)."
        ),
        no_open: bool = typer.Option(
            False, "--no-open", help="Don't launch a browser; with --html, write the file and exit."
        ),
    ) -> None:
        """Show active pack per scope and per-CLI sync state."""
        cfg = load_config(config_path)
        project_root = find_project_root(Path.cwd())
        data = _gather(cfg)

        # Write-only path: --html-out, or --html + --no-open.
        if html_out is not None or (html and no_open):
            if html_out is not None:
                out_path = html_out
            else:
                cache_root = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
                out_path = cache_root / "skillex" / "status.html"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(
                _render_html(cfg, data, project_root, config_path), encoding="utf-8"
            )
            console.print(f"[green]✓[/green] HTML report: [bold]{out_path}[/bold]")
            return

        # Serve mode: spin up localhost server, open browser, block until Ctrl-C.
        if html:
            html_text = _render_html(cfg, data, project_root, config_path)
            try:
                url, server = _serve_html(html_text, port)
            except OSError as e:
                console.print(f"[red]Failed to start server:[/red] {e}")
                raise typer.Exit(code=1) from e
            console.print(
                f"[green]✓[/green] Serving status at [bold]{url}[/bold] — press Ctrl-C to stop."
            )
            try:
                webbrowser.open(url)
            except Exception:
                pass
            try:
                while True:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                console.print("[dim]stopped.[/dim]")
            finally:
                server.shutdown()
                server.server_close()
            return

        _render_terminal(cfg, data, project_root)
