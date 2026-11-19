import type { SkillGraphData } from "./skill-graph.js";

/**
 * A self-contained page for one skill graph: repository and hub health first (the questions
 * people ask), then a filterable force graph. `#hub=<name>` deep-links a hub card, so another
 * page (the 33GOD Atlas) can link straight to a component's hub.
 */
export function renderSkillGraphHtml(data: SkillGraphData, generatedAt = new Date()): string {
  const payload = JSON.stringify({ ...data, generatedAt: generatedAt.toISOString() }).replace(
    /</g,
    "\\u003c",
  );
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
  <h1>Skill Graph</h1>
  <p class="sub" id="meta"></p>
  <div class="tiles" id="tiles"></div>
</header>
<main>
  <section>
    <h2>Repositories</h2>
    <p class="hint">Every source in <code>all-skills/sources.toml</code>. A repository owns exactly one hub.</p>
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
--hub:#5b4bd6;--vendored:#2b7fbf;--wild:#8a8778;--subskill:#a35bd6;--set:#3a9d8f;--pack:#c06c2b;--source:#1d1d1b;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1e1e1c;--ink:#ecebe6;--muted:#a19f96;--line:#33322e;--ok:#5fc48a;--warn:#e0a84a;--err:#f07171;
--hub:#9b8cff;--vendored:#5fb0ea;--wild:#8f8c80;--subskill:#c995f2;--set:#5cc6b6;--pack:#e39a5c;--source:#ecebe6;}}
:root[data-theme="dark"]{--bg:#151514;--panel:#1e1e1c;--ink:#ecebe6;--muted:#a19f96;--line:#33322e;--ok:#5fc48a;--warn:#e0a84a;--err:#f07171;
--hub:#9b8cff;--vendored:#5fb0ea;--wild:#8f8c80;--subskill:#c995f2;--set:#5cc6b6;--pack:#e39a5c;--source:#ecebe6;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:1200px;margin:0 auto;padding:0 16px}
header{padding-top:28px}
h1{margin:0;font-size:28px;letter-spacing:-.01em}
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
.ok{color:var(--ok)}.warning{color:var(--warn)}.error{color:var(--err)}
.controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:8px 0 12px}
.controls label{font-size:14px;display:inline-flex;gap:6px;align-items:center}
input[type=search]{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);min-width:200px}
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

document.getElementById("meta").textContent = data.registry.root + " · generated " + data.generatedAt.replace("T"," ").slice(0,16) + " UTC";
var s = data.summary;
[["hubs",s.nodes.hub],["vendored",s.nodes.vendored],["wild",s.nodes.wild],["sub-skills",s.nodes.subskill],["sources",s.nodes.source],["sets",s.nodes.set],["packs",s.nodes.pack],["nodes in error",s.health.error]].forEach(function(t){
  var d=el("div",{class:"tile"});d.appendChild(el("b",null,String(t[1])));d.appendChild(el("span",null,t[0]));document.getElementById("tiles").appendChild(d);
});

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
var hubNodes = data.nodes.filter(function(n){return n.kind==="hub"||n.kind==="vendored";});
var cards=document.getElementById("hubs");
function names(list, key){return list.map(function(e){var n=byId.get(e[key]);return n?n.name:e[key];});}
function list(dl, label, items){if(!items.length)return;dl.appendChild(el("dt",null,label));dl.appendChild(el("dd",null,items.join(", ")));}
hubNodes.forEach(function(n){
  var c=el("article",{class:"card",id:"hub-"+n.name,"data-name":n.name,"data-health":n.health});
  var h=el("h3");h.appendChild(document.createTextNode(n.name));h.appendChild(pill(n.health));h.appendChild(el("span",{class:"kind"},n.kind));c.appendChild(h);
  c.appendChild(el("div",{class:"src"},(n.source?"source "+n.source:"no source")+(n.root?" · "+n.root:"")));
  var dl=el("dl");var o=out[n.id]||[], i=inc[n.id]||[];
  list(dl,"sub-skills",names(o.filter(function(e){return e.kind==="routes";}),"to").map(function(x){return x.split("/").pop();}));
  list(dl,"loads",names(o.filter(function(e){return e.kind==="loads";}),"to"));
  list(dl,"mentions",names(o.filter(function(e){return e.kind==="mentions";}),"to"));
  list(dl,"loaded by",names(i.filter(function(e){return e.kind==="loads";}),"from"));
  list(dl,"in",names(i.filter(function(e){return e.kind==="member";}),"from"));
  c.appendChild(dl);
  if(n.findings.length){var d=el("details");d.appendChild(el("summary",null,n.findings.length+" findings"));var ul=el("ul");
    n.findings.forEach(function(f){var li=el("li");li.appendChild(el("b",{class:f.severity==="error"?"error":f.severity==="warning"?"warning":""},f.code));li.appendChild(document.createTextNode(" "+f.message+(f.path?" ("+f.path.replace(n.path||"","")+")":"")));ul.appendChild(li);});
    d.appendChild(ul);c.appendChild(d);}
  cards.appendChild(c);
});
function filterCards(){var q=document.getElementById("hubFilter").value.toLowerCase();var bad=document.getElementById("onlyBad").checked;
  cards.querySelectorAll(".card").forEach(function(c){c.hidden=(q&&c.dataset.name.indexOf(q)<0)||(bad&&c.dataset.health==="ok");});}
document.getElementById("hubFilter").addEventListener("input",filterCards);
document.getElementById("onlyBad").addEventListener("change",filterCards);
function target(){var m=/hub=([^&]+)/.exec(location.hash);if(!m)return;var c=document.getElementById("hub-"+decodeURIComponent(m[1]));if(!c)return;
  cards.querySelectorAll(".target").forEach(function(x){x.classList.remove("target");});c.classList.add("target");c.scrollIntoView({block:"center"});}
window.addEventListener("hashchange",target);target();

// Graph.
if(!window.d3){document.getElementById("graph").textContent="The graph needs d3 from cdnjs; the tables above are complete without it.";return;}
var nodeKinds=["hub","vendored","subskill","source","wild","set","pack"], edgeKinds=["owns","vendors","routes","loads","member","mentions"];
var showNode={hub:1,vendored:1,subskill:1,source:1,wild:1,set:0,pack:0}, showEdge={owns:1,vendors:1,routes:1,loads:1,member:0,mentions:0};
var controls=document.getElementById("graphControls");
function css(v){return getComputedStyle(document.documentElement).getPropertyValue("--"+v).trim();}
nodeKinds.forEach(function(k){var l=el("label");var i=el("input",{type:"checkbox"});i.checked=!!showNode[k];i.onchange=function(){showNode[k]=i.checked?1:0;draw();};
  l.appendChild(i);var sw=el("span",{class:"swatch"});sw.style.background="var(--"+k+")";l.appendChild(sw);l.appendChild(document.createTextNode(k));controls.appendChild(l);});
edgeKinds.forEach(function(k){var l=el("label");var i=el("input",{type:"checkbox"});i.checked=!!showEdge[k];i.onchange=function(){showEdge[k]=i.checked?1:0;draw();};
  l.appendChild(i);l.appendChild(document.createTextNode("→ "+k));controls.appendChild(l);});
var svg=d3.select("#graph svg"), tip=document.getElementById("tip"), sim;
var root=svg.append("g");
svg.call(d3.zoom().scaleExtent([0.1,6]).on("zoom",function(ev){root.attr("transform",ev.transform);}));
function draw(){
  if(sim)sim.stop();root.selectAll("*").remove();
  var es=data.edges.filter(function(e){return showEdge[e.kind]&&byId.has(e.from)&&byId.has(e.to)&&showNode[byId.get(e.from).kind]&&showNode[byId.get(e.to).kind];});
  // A wild skill is drawn only when a visible edge touches it; 400 isolated dots say nothing.
  var touched=new Set();es.forEach(function(e){touched.add(e.from);touched.add(e.to);});
  var ns=data.nodes.filter(function(n){return showNode[n.kind]&&(n.kind!=="wild"||touched.has(n.id));}).map(function(n){return Object.assign({},n);});
  var ids=new Set(ns.map(function(n){return n.id;}));
  var ls=es.filter(function(e){return ids.has(e.from)&&ids.has(e.to);}).map(function(e){return {source:e.from,target:e.to,kind:e.kind};});
  var w=document.getElementById("graph").clientWidth,h=document.getElementById("graph").clientHeight;
  sim=d3.forceSimulation(ns).force("link",d3.forceLink(ls).id(function(d){return d.id;}).distance(function(l){return l.kind==="routes"?30:70;}))
    .force("charge",d3.forceManyBody().strength(-90)).force("center",d3.forceCenter(w/2,h/2)).force("collide",d3.forceCollide(10));
  var link=root.append("g").attr("stroke-opacity",.45).selectAll("line").data(ls).join("line")
    .attr("stroke",function(l){return l.kind==="loads"?css("hub"):css("muted");}).attr("stroke-dasharray",function(l){return l.kind==="mentions"?"2 3":null;}).attr("stroke-width",function(l){return l.kind==="loads"?1.6:1;});
  var node=root.append("g").selectAll("g").data(ns).join("g").call(d3.drag()
    .on("start",function(ev,d){if(!ev.active)sim.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
    .on("drag",function(ev,d){d.fx=ev.x;d.fy=ev.y;}).on("end",function(ev,d){if(!ev.active)sim.alphaTarget(0);d.fx=null;d.fy=null;}));
  node.append("circle").attr("r",function(d){return d.kind==="hub"||d.kind==="source"?8:d.kind==="subskill"?4:6;})
    .attr("fill",function(d){return css(d.kind);}).attr("stroke",function(d){return d.health==="ok"?css("panel"):css(d.health==="error"?"err":"warn");}).attr("stroke-width",function(d){return d.health==="ok"?1:3;});
  node.filter(function(d){return d.kind==="hub"||d.kind==="source"||d.kind==="vendored";}).append("text").text(function(d){return d.name;})
    .attr("x",10).attr("y",4).attr("font-size",11).attr("fill",css("ink"));
  node.on("mouseenter",function(ev,d){tip.hidden=false;tip.textContent=d.kind+" · "+d.name+(d.findings.length?" · "+d.findings.length+" findings":"")+(d.description?"\n"+d.description.slice(0,160):"");tip.style.whiteSpace="pre-line";})
    .on("mousemove",function(ev){var r=document.getElementById("graph").getBoundingClientRect();tip.style.left=Math.min(ev.clientX-r.left+12,r.width-330)+"px";tip.style.top=(ev.clientY-r.top+12)+"px";})
    .on("mouseleave",function(){tip.hidden=true;})
    .on("click",function(ev,d){if(d.kind==="hub"||d.kind==="vendored")location.hash="hub="+encodeURIComponent(d.name);});
  sim.on("tick",function(){link.attr("x1",function(l){return l.source.x;}).attr("y1",function(l){return l.source.y;}).attr("x2",function(l){return l.target.x;}).attr("y2",function(l){return l.target.y;});
    node.attr("transform",function(d){return "translate("+d.x+","+d.y+")";});});
}
draw();
})();
`;
