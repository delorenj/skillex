import type { Diagnostic } from "./result.js";
import type { SkillGraphData } from "./skill-graph.js";

export interface SkillGraphHtmlOptions {
  /** Served by `skillex graph --serve`: show the context picker and make nodes refocus the view. */
  readonly live?: boolean;
  /** Findings from the read that produced the graph (context, focus, catalog). */
  readonly findings?: readonly Diagnostic[];
}

/**
 * A self-contained page for one skill graph: the context and what needs attention in it first,
 * then repository and hub health, then a filterable force graph. `#hub=<name>` deep-links a
 * hub card, so another page (the 33GOD Atlas) can link straight to a component's hub.
 */
export function renderSkillGraphHtml(
  data: SkillGraphData,
  generatedAt = new Date(),
  options: SkillGraphHtmlOptions = {},
): string {
  const payload = JSON.stringify({
    ...data,
    generatedAt: generatedAt.toISOString(),
    live: options.live === true,
    readFindings: options.findings ?? [],
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Graph</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Skill Graph <span id="ctxName" class="ctx"></span></h1>
  <p class="sub" id="meta"></p>
  <form id="picker" class="controls" hidden>
    <label>Context <select name="context" id="ctxSelect"></select></label>
    <label>Focus <input type="search" name="focus" id="focusInput" placeholder="skill or hub, comma-separated"></label>
    <label>Depth <input type="number" name="depth" id="depthInput" min="0" step="1" placeholder="1"></label>
    <button type="submit">Show</button>
    <a id="clearFocus" href="#" hidden>clear focus</a>
  </form>
  <p class="hint" id="snapshot" hidden>A snapshot written by <code>skillex graph --html</code>. The live view is <code>skillex graph --serve</code>.</p>
  <div class="tiles" id="tiles"></div>
</header>
<main>
  <section id="contextSection" hidden>
    <h2>Needs attention in this context</h2>
    <p class="hint" id="resolver"></p>
    <div class="scroll"><table id="attention"><thead><tr><th>Skill</th><th>Status</th><th>Tier</th><th>Finding</th></tr></thead><tbody></tbody></table></div>
    <details id="rootsBox"><summary>Skill roots, in precedence order</summary><ul id="roots"></ul></details>
  </section>
  <section>
    <h2>Repositories</h2>
    <p class="hint">Every source in <code>all-skills/sources.toml</code> with a skill in this view. A repository owns exactly one hub.</p>
    <div class="scroll"><table id="sources"><thead><tr><th>Source</th><th>Mode</th><th>Hubs on disk</th><th>Health</th><th>Repo dir</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Hubs</h2>
    <p class="hint">Repo-owned hubs and first-party vendored copies, with their sub-skills, what they load and who loads them.</p>
    <div class="controls"><input id="hubFilter" type="search" placeholder="Filter hubs"><label><input type="checkbox" id="onlyBad"> only with findings</label></div>
    <div class="cards" id="hubs"></div>
  </section>
  <section>
    <h2>Graph</h2>
    <p class="hint" id="graphHint"></p>
    <div class="controls" id="graphControls"></div>
    <div id="graph"><svg role="img" aria-label="Skill dependency graph"></svg><div id="tip" hidden></div></div>
  </section>
</main>
<script id="data" type="application/json">${payload}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root{--bg:#fbfaf7;--panel:#ffffff;--ink:#1d1d1b;--muted:#6b6a64;--line:#e4e1d8;--ok:#2f7d4f;--warn:#b7791f;--err:#c53030;
--hub:#5b4bd6;--vendored:#2b7fbf;--wild:#8a8778;--local:#b5487a;--subskill:#a35bd6;--set:#3a9d8f;--pack:#c06c2b;--source:#1d1d1b;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1e1e1c;--ink:#ecebe6;--muted:#a19f96;--line:#33322e;--ok:#5fc48a;--warn:#e0a84a;--err:#f07171;
--hub:#9b8cff;--vendored:#5fb0ea;--wild:#8f8c80;--local:#e57fae;--subskill:#c995f2;--set:#5cc6b6;--pack:#e39a5c;--source:#ecebe6;}}
:root[data-theme="dark"]{--bg:#151514;--panel:#1e1e1c;--ink:#ecebe6;--muted:#a19f96;--line:#33322e;--ok:#5fc48a;--warn:#e0a84a;--err:#f07171;
--hub:#9b8cff;--vendored:#5fb0ea;--wild:#8f8c80;--local:#e57fae;--subskill:#c995f2;--set:#5cc6b6;--pack:#e39a5c;--source:#ecebe6;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:1200px;margin:0 auto;padding:0 16px}
header{padding-top:28px}
h1{margin:0;font-size:28px;letter-spacing:-.01em}
h1 .ctx{font-weight:500;color:var(--muted);font-size:20px}
h2{font-size:19px;margin:32px 0 4px}
.sub,.hint{color:var(--muted);margin:4px 0 12px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.tile span{color:var(--muted);font-size:13px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:10px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
th{color:var(--muted);font-weight:600}
.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;border:1px solid currentColor}
.ok,.loaded{color:var(--ok)}.warning,.quarantined,.shadowed,.disabled{color:var(--warn)}.error,.broken,.missing,.ambiguous{color:var(--err)}.unavailable,.info{color:var(--muted)}
.controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:8px 0 12px}
.controls label{font-size:14px;display:inline-flex;gap:6px;align-items:center}
input[type=search],input[type=number],select,button{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:14px}
input[type=search]{min-width:200px}
input[type=number]{width:72px}
button{cursor:pointer}
a{color:var(--hub)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;scroll-margin-top:16px}
.card.target{outline:2px solid var(--hub)}
.card h3{margin:0;font-size:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card .src{color:var(--muted);font-size:13px}
.card dl{margin:8px 0 0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
.card dt{color:var(--muted)}
.card dd{margin:0}
.card details{margin-top:8px;font-size:13px}
.card li{margin:2px 0}
.kind{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
#roots{font-size:13px;color:var(--muted)}
#graph{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:12px;height:70vh;min-height:420px;overflow:hidden}
#graph svg{width:100%;height:100%}
#tip{position:absolute;pointer-events:none;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:13px;max-width:320px}
.swatch{display:inline-block;width:10px;height:10px;border-radius:50%}
@media (max-width:600px){.cards{grid-template-columns:1fr}input[type=search]{min-width:0;width:100%}}
`;

const SCRIPT = String.raw`
(function(){
var data = JSON.parse(document.getElementById("data").textContent);
var byId = new Map(data.nodes.map(function(n){return [n.id,n];}));
function el(tag, attrs, text){var e=document.createElement(tag);for(var k in (attrs||{}))e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;}
function pill(h){return el("span",{class:"pill "+h},h);}
var out = {}, inc = {};
data.edges.forEach(function(e){(out[e.from]=out[e.from]||[]).push(e);(inc[e.to]=inc[e.to]||[]).push(e);});
var ctx = data.context || {kind:"catalog",label:"catalog",id:"catalog",roots:[],counts:{}};
var inContext = ctx.kind !== "catalog";
var focus = data.focus || null;
function status(n){return n.context ? n.context.status : null;}

// Header.
document.getElementById("ctxName").textContent = "· " + ctx.label + (focus ? " · focus " + focus.names.join(", ") : "");
document.getElementById("meta").textContent = (ctx.detectedFrom ? "detected from " + ctx.detectedFrom + " · " : "") + "registry " + data.registry.root + " · " + (data.live ? "read live " : "generated ") + data.generatedAt.replace("T"," ").slice(0,19) + " UTC";
function viewUrl(params){var q=new URLSearchParams();q.set("context",params.context||ctx.id);if(params.focus)q.set("focus",params.focus);if(params.depth!=null&&params.depth!=="")q.set("depth",params.depth);return "?"+q.toString();}
if (data.live) {
  var form=document.getElementById("picker");form.hidden=false;
  var select=document.getElementById("ctxSelect");
  function option(id,label){var o=el("option",{value:id},label);if(id===ctx.id)o.selected=true;select.appendChild(o);}
  option(ctx.id, ctx.label);
  fetch("/contexts.json").then(function(r){return r.json();}).then(function(list){list.forEach(function(c){if(c.id!==ctx.id)option(c.id,c.label);});}).catch(function(){});
  if(focus){document.getElementById("focusInput").value=focus.names.join(",");document.getElementById("depthInput").value=String(focus.depth);
    var clear=document.getElementById("clearFocus");clear.hidden=false;clear.href=viewUrl({context:ctx.id});}
  form.addEventListener("submit",function(ev){ev.preventDefault();location.search=viewUrl({context:select.value,focus:document.getElementById("focusInput").value.trim(),depth:document.getElementById("depthInput").value});});
} else document.getElementById("snapshot").hidden=false;

// Tiles.
var s = data.summary, c = ctx.counts || {};
var tiles = inContext
  ? [["loaded",c.loaded],["hubs",s.nodes.hub],["vendored",s.nodes.vendored],["wild",s.nodes.wild],["local",s.nodes.local],["shadowed",c.shadowed],["disabled",c.disabled],["quarantined",c.quarantined],["broken",c.broken],["missing",c.missing],["ambiguous",c.ambiguous],["points at unavailable",c.unavailable],["nodes in error",s.health.error]]
  : [["hubs",s.nodes.hub],["vendored",s.nodes.vendored],["wild",s.nodes.wild],["sub-skills",s.nodes.subskill],["sources",s.nodes.source],["sets",s.nodes.set],["packs",s.nodes.pack],["nodes in error",s.health.error]];
tiles.forEach(function(t){if(t[1]==null)return;
  var d=el("div",{class:"tile"});d.appendChild(el("b",null,String(t[1])));d.appendChild(el("span",null,t[0]));document.getElementById("tiles").appendChild(d);
});

// Context: what needs attention.
if (inContext) {
  document.getElementById("contextSection").hidden=false;
  document.getElementById("resolver").textContent="Read by " + ctx.resolver + ". Each row is a skill this context cannot load cleanly, or a skill whose routing points somewhere it cannot follow.";
  var roots=document.getElementById("roots");(ctx.roots||[]).forEach(function(r){roots.appendChild(el("li",null,r.tier+": "+r.path));});
  var abody=document.querySelector("#attention tbody"), rows=0;
  var rank={error:0,warning:1,info:2};
  data.nodes.filter(function(n){return n.context&&n.context.status!=="unavailable"&&(n.context.status!=="loaded"||n.findings.some(function(f){return /CONTEXT/.test(f.code);}));})
    .sort(function(a,b){return (rank[a.health==="ok"?"info":a.health]-rank[b.health==="ok"?"info":b.health])||a.name.localeCompare(b.name);})
    .forEach(function(n){
      var tr=el("tr"),name=el("td");
      if(data.live){var a=el("a",{href:viewUrl({context:ctx.id,focus:n.name})},n.name);name.appendChild(a);}else name.textContent=n.name;
      tr.appendChild(name);
      var st=el("td");st.appendChild(pill(n.context.status));tr.appendChild(st);
      tr.appendChild(el("td",null,n.context.entries.map(function(e){return e.tier;}).filter(Boolean).join(", ")));
      var fs=n.findings.filter(function(f){return /CONTEXT/.test(f.code);});
      var ft=el("td");fs.forEach(function(f){var p=el("div");p.appendChild(el("b",{class:f.severity},f.code));p.appendChild(document.createTextNode(" "+f.message));ft.appendChild(p);});
      tr.appendChild(ft);abody.appendChild(tr);rows++;
    });
  (data.readFindings||[]).filter(function(f){return f.severity!=="info";}).forEach(function(f){
    var tr=el("tr");tr.appendChild(el("td",null,f.name||"(catalog)"));var st=el("td");st.appendChild(pill(f.severity));tr.appendChild(st);tr.appendChild(el("td",null,""));
    var ft=el("td");ft.appendChild(el("b",{class:f.severity},f.code));ft.appendChild(document.createTextNode(" "+f.message));tr.appendChild(ft);abody.appendChild(tr);rows++;});
  if(!rows){var tr=el("tr");var td=el("td",{colspan:"4"},"Nothing: every skill in this context loads cleanly.");tr.appendChild(td);abody.appendChild(tr);}
}

// Repositories.
var tbody=document.querySelector("#sources tbody");
data.nodes.filter(function(n){return n.kind==="source";}).forEach(function(n){
  var tr=el("tr");tr.appendChild(el("td",null,n.name));tr.appendChild(el("td",null,n.mode));
  var hubs=el("td");var count=(n.hubs||[]).length;var b=el("b",{class:count>1?(n.mode==="link"?"error":"warning"):""},String(count));hubs.appendChild(b);
  if(count) hubs.appendChild(document.createTextNode(" " + n.hubs.join(", ")));
  tr.appendChild(hubs);
  var h=el("td");h.appendChild(pill(n.health));if(n.findings.length)h.title=n.findings.map(function(f){return f.code+": "+f.message;}).join("\n");tr.appendChild(h);
  tr.appendChild(el("td",null,n.root||"(no checkout)"));tbody.appendChild(tr);
});

// Hub cards: repo-owned hubs plus vendored skills.
var hubNodes = data.nodes.filter(function(n){return (n.kind==="hub"||n.kind==="vendored")&&status(n)!=="unavailable";});
var cards=document.getElementById("hubs");
function names(list, key){return list.map(function(e){var n=byId.get(e[key]);return n?n.name:e[key];});}
function list(dl, label, items){if(!items.length)return;dl.appendChild(el("dt",null,label));dl.appendChild(el("dd",null,items.join(", ")));}
hubNodes.forEach(function(n){
  var c=el("article",{class:"card",id:"hub-"+n.name,"data-name":n.name,"data-health":n.health});
  var h=el("h3");
  if(data.live){h.appendChild(el("a",{href:viewUrl({context:ctx.id,focus:n.name})},n.name));}else h.appendChild(document.createTextNode(n.name));
  h.appendChild(pill(n.health));if(status(n)&&status(n)!=="loaded")h.appendChild(pill(status(n)));h.appendChild(el("span",{class:"kind"},n.kind));c.appendChild(h);
  c.appendChild(el("div",{class:"src"},(n.source?"source "+n.source:"no source")+(n.root?" · "+n.root:"")));
  var dl=el("dl");var o=out[n.id]||[], i=inc[n.id]||[];
  list(dl,"sub-skills",names(o.filter(function(e){return e.kind==="routes";}),"to").map(function(x){return x.split("/").pop();}));
  list(dl,"loads",names(o.filter(function(e){return e.kind==="loads";}),"to"));
  list(dl,"mentions",names(o.filter(function(e){return e.kind==="mentions";}),"to"));
  list(dl,"loaded by",names(i.filter(function(e){return e.kind==="loads";}),"from"));
  list(dl,"in",names(i.filter(function(e){return e.kind==="member";}),"from"));
  c.appendChild(dl);
  if(n.findings.length){var d=el("details");d.appendChild(el("summary",null,n.findings.length+" findings"));var ul=el("ul");
    n.findings.forEach(function(f){var li=el("li");li.appendChild(el("b",{class:f.severity},f.code));li.appendChild(document.createTextNode(" "+f.message+(f.path?" ("+f.path.replace(n.path||"","")+")":"")));ul.appendChild(li);});
    d.appendChild(ul);c.appendChild(d);}
  cards.appendChild(c);
});
if(!hubNodes.length)cards.appendChild(el("p",{class:"hint"},"No hubs or vendored skills in this view."));
function filterCards(){var q=document.getElementById("hubFilter").value.toLowerCase();var bad=document.getElementById("onlyBad").checked;
  cards.querySelectorAll(".card").forEach(function(c){c.hidden=(q&&c.dataset.name.indexOf(q)<0)||(bad&&c.dataset.health==="ok");});}
document.getElementById("hubFilter").addEventListener("input",filterCards);
document.getElementById("onlyBad").addEventListener("change",filterCards);
function target(){var m=/hub=([^&]+)/.exec(location.hash);if(!m)return;var c=document.getElementById("hub-"+decodeURIComponent(m[1]));if(!c)return;
  cards.querySelectorAll(".target").forEach(function(x){x.classList.remove("target");});c.classList.add("target");c.scrollIntoView({block:"center"});}
window.addEventListener("hashchange",target);target();

// Graph.
document.getElementById("graphHint").textContent = (data.live ? "Click a skill to focus on it. " : "") + (inContext ? "Faded, dashed nodes are skills this context cannot load that a visible skill points at. " : "") + "Drag to move, scroll to zoom.";
if(!window.d3){document.getElementById("graph").textContent="The graph needs d3 from cdnjs; the tables above are complete without it.";return;}
var nodeKinds=["hub","vendored","local","subskill","source","wild","set","pack"], edgeKinds=["owns","vendors","routes","loads","member","mentions"];
var small = data.nodes.length <= 150;
var showNode={hub:1,vendored:1,local:1,subskill:1,source:1,wild:1,set:small?1:0,pack:small?1:0}, showEdge={owns:1,vendors:1,routes:1,loads:1,member:small?1:0,mentions:small?1:0};
var seeds=new Set(focus?focus.seeds:[]);
var controls=document.getElementById("graphControls");
function css(v){return getComputedStyle(document.documentElement).getPropertyValue("--"+v).trim();}
nodeKinds.forEach(function(k){if(!data.summary.nodes[k])return;var l=el("label");var i=el("input",{type:"checkbox"});i.checked=!!showNode[k];i.onchange=function(){showNode[k]=i.checked?1:0;draw();};
  l.appendChild(i);var sw=el("span",{class:"swatch"});sw.style.background="var(--"+k+")";l.appendChild(sw);l.appendChild(document.createTextNode(k));controls.appendChild(l);});
edgeKinds.forEach(function(k){if(!data.summary.edges[k])return;var l=el("label");var i=el("input",{type:"checkbox"});i.checked=!!showEdge[k];i.onchange=function(){showEdge[k]=i.checked?1:0;draw();};
  l.appendChild(i);l.appendChild(document.createTextNode("→ "+k));controls.appendChild(l);});
var svg=d3.select("#graph svg"), tip=document.getElementById("tip"), sim;
var root=svg.append("g");
svg.call(d3.zoom().scaleExtent([0.1,6]).on("zoom",function(ev){root.attr("transform",ev.transform);}));
function draw(){
  if(sim)sim.stop();root.selectAll("*").remove();
  var es=data.edges.filter(function(e){return showEdge[e.kind]&&byId.has(e.from)&&byId.has(e.to)&&showNode[byId.get(e.from).kind]&&showNode[byId.get(e.to).kind];});
  // A wild skill is drawn only when a visible edge touches it; 400 isolated dots say nothing.
  var touched=new Set();es.forEach(function(e){touched.add(e.from);touched.add(e.to);});
  var ns=data.nodes.filter(function(n){return showNode[n.kind]&&(small||n.kind!=="wild"||touched.has(n.id)||seeds.has(n.id));}).map(function(n){return Object.assign({},n);});
  var ids=new Set(ns.map(function(n){return n.id;}));
  var ls=es.filter(function(e){return ids.has(e.from)&&ids.has(e.to);}).map(function(e){return {source:e.from,target:e.to,kind:e.kind};});
  var w=document.getElementById("graph").clientWidth,h=document.getElementById("graph").clientHeight;
  sim=d3.forceSimulation(ns).force("link",d3.forceLink(ls).id(function(d){return d.id;}).distance(function(l){return l.kind==="routes"?30:70;}))
    .force("charge",d3.forceManyBody().strength(small?-220:-90)).force("center",d3.forceCenter(w/2,h/2)).force("collide",d3.forceCollide(small?18:10));
  var link=root.append("g").attr("stroke-opacity",.45).selectAll("line").data(ls).join("line")
    .attr("stroke",function(l){return l.kind==="loads"?css("hub"):css("muted");}).attr("stroke-dasharray",function(l){return l.kind==="mentions"?"2 3":null;}).attr("stroke-width",function(l){return l.kind==="loads"?1.6:1;});
  var node=root.append("g").selectAll("g").data(ns).join("g").style("cursor","pointer").attr("opacity",function(d){return status(d)==="unavailable"?.45:1;}).call(d3.drag()
    .on("start",function(ev,d){if(!ev.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
    .on("drag",function(ev,d){d.fx=ev.x;d.fy=ev.y;}).on("end",function(ev,d){if(!ev.active)sim.alphaTarget(0);d.fx=null;d.fy=null;}));
  node.append("circle").attr("r",function(d){return seeds.has(d.id)?11:d.kind==="hub"||d.kind==="source"?8:d.kind==="subskill"?4:6;})
    .attr("fill",function(d){return css(d.kind);})
    .attr("stroke",function(d){return d.health==="ok"?css(seeds.has(d.id)?"ink":"panel"):css(d.health==="error"?"err":"warn");})
    .attr("stroke-width",function(d){return d.health==="ok"&&!seeds.has(d.id)?1:3;})
    .attr("stroke-dasharray",function(d){return status(d)==="unavailable"?"2 2":null;});
  node.filter(function(d){return small||seeds.has(d.id)||d.kind==="hub"||d.kind==="source"||d.kind==="vendored"||d.kind==="local";}).append("text").text(function(d){return d.name;})
    .attr("x",10).attr("y",4).attr("font-size",11).attr("fill",css("ink"));
  node.on("mouseenter",function(ev,d){tip.hidden=false;tip.textContent=d.kind+" · "+d.name+(status(d)?" · "+status(d):"")+(d.findings.length?" · "+d.findings.length+" findings":"")+(d.description?"\n"+d.description.slice(0,160):"");tip.style.whiteSpace="pre-line";})
    .on("mousemove",function(ev){var r=document.getElementById("graph").getBoundingClientRect();tip.style.left=Math.max(0,Math.min(ev.clientX-r.left+12,r.width-330))+"px";tip.style.top=(ev.clientY-r.top+12)+"px";})
    .on("mouseleave",function(){tip.hidden=true;})
    .on("click",function(ev,d){
      if(data.live&&d.kind!=="source"){location.search=viewUrl({context:ctx.id,focus:d.kind==="subskill"?d.name.split("/")[0]:d.name,depth:focus?focus.depth:""});return;}
      if(d.kind==="hub"||d.kind==="vendored")location.hash="hub="+encodeURIComponent(d.name);});
  sim.on("tick",function(){link.attr("x1",function(l){return l.source.x;}).attr("y1",function(l){return l.source.y;}).attr("x2",function(l){return l.target.x;}).attr("y2",function(l){return l.target.y;});
    node.attr("transform",function(d){return "translate("+d.x+","+d.y+")";});});
}
draw();
})();
`;
