import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Diagnostic } from "./result.js";
import {
  contextSkillGraph,
  listGraphContexts,
  type SkillGraphContextOptions,
} from "./skill-graph-context.js";
import { renderSkillGraphHtml } from "./skill-graph-html.js";

/**
 * `skillex graph --serve`: the live graph. Every request reads the skill roots from disk again
 * (nothing is cached past the request), so the page can never drift from what agents load.
 *
 *   GET /               the page   (?context=&focus=a,b&depth=)
 *   GET /graph.json     the result envelope for the same query
 *   GET /contexts.json  the contexts a viewer can pick
 *   GET /healthz        ok
 */

export interface SkillGraphServeOptions extends SkillGraphContextOptions {
  readonly host?: string;
  readonly port?: number;
  readonly log?: (line: string) => void;
}

export interface SkillGraphQuery {
  readonly context?: string;
  readonly focus?: readonly string[];
  readonly depth?: number;
}

export function parseFocus(values: readonly string[] | string | undefined): string[] {
  const list = typeof values === "string" ? [values] : (values ?? []);
  return list
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseDepth(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (value === "all") return 0;
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 0 ? depth : null;
}

function queryOf(url: URL, defaults: SkillGraphServeOptions): SkillGraphQuery {
  const focus = parseFocus(url.searchParams.getAll("focus"));
  const depth = parseDepth(url.searchParams.get("depth") ?? undefined);
  const context = url.searchParams.get("context") || defaults.context;
  return {
    ...(context ? { context } : {}),
    ...(focus.length ? { focus } : defaults.focus?.length ? { focus: defaults.focus } : {}),
    ...(depth !== null ? { depth } : defaults.depth !== undefined ? { depth: defaults.depth } : {}),
  };
}

export function startSkillGraphServer(
  options: SkillGraphServeOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18799;
  const log = options.log ?? (() => {});
  // No sharing and no cache: a request that arrives after a change on disk must see it.
  const read = (query: SkillGraphQuery) => contextSkillGraph({ ...options, ...query });
  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
    });
    res.end(body);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://skillex.local");
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "text/plain", "GET only\n");
      return;
    }
    if (url.pathname === "/healthz") {
      send(res, 200, "text/plain", "ok\n");
      return;
    }
    if (url.pathname === "/contexts.json") {
      send(res, 200, "application/json", JSON.stringify(await listGraphContexts(options)));
      return;
    }
    if (url.pathname !== "/" && url.pathname !== "/index.html" && url.pathname !== "/graph.json") {
      send(res, 404, "text/plain", "not found\n");
      return;
    }
    const query = queryOf(url, options);
    const started = Date.now();
    const result = await read(query);
    log(
      `${new Date().toISOString()} ${url.pathname}${url.search} -> exit ${result.exit} in ${Date.now() - started}ms`,
    );
    if (url.pathname === "/graph.json") {
      send(res, result.data ? 200 : 422, "application/json", JSON.stringify(result));
      return;
    }
    if (!result.data) {
      send(res, 422, "text/html", errorPage(result.findings, query));
      return;
    }
    send(
      res,
      200,
      "text/html",
      renderSkillGraphHtml(result.data, new Date(), { live: true, findings: result.findings }),
    );
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent)
        send(res, 500, "text/plain", "skill graph failed; see the server log\n");
      else res.end();
    });
  });
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      done({
        url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}/`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function errorPage(findings: readonly Diagnostic[], query: SkillGraphQuery): string {
  const items = findings
    .map(
      (f) =>
        `<li><b>${escapeHtml(f.code)}</b> ${escapeHtml(f.message)}${f.fix ? `<br><small>${escapeHtml(f.fix)}</small>` : ""}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skill Graph</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#fbfaf7;color:#1d1d1b}@media (prefers-color-scheme: dark){body{background:#151514;color:#ecebe6}}a{color:inherit}</style></head>
<body><h1>Skill Graph</h1><p>The graph for <code>${escapeHtml(JSON.stringify(query))}</code> could not be read:</p><ul>${items}</ul><p><a href="/">Back to the default view</a></p></body></html>`;
}
