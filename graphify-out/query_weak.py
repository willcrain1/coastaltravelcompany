import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
from collections import defaultdict
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

# Find weakly connected components
weak_components = list(nx.weakly_connected_components(G) if G.is_directed() else nx.connected_components(G))
weak_components.sort(key=len, reverse=True)

print(f"Total connected components: {len(weak_components)}")
print(f"Largest component: {len(weak_components[0])} nodes")
if len(weak_components) > 1:
    print(f"Second component: {len(weak_components[1])} nodes")
    print(f"All component sizes: {[len(c) for c in weak_components]}")
    print()

# Nodes with degree 0 or 1 (isolated or near-isolated)
low_degree = [(nid, G.degree(nid), G.nodes[nid]) for nid in G.nodes() if G.degree(nid) <= 1]
low_degree.sort(key=lambda x: x[1])

print(f"Nodes with degree 0 (isolated): {sum(1 for _, d, _ in low_degree if d == 0)}")
print(f"Nodes with degree 1 (single connection): {sum(1 for _, d, _ in low_degree if d == 1)}")
print(f"Nodes with degree <= 2: {sum(1 for nid in G.nodes() if G.degree(nid) <= 2)}")
print(f"Nodes with degree <= 3: {sum(1 for nid in G.nodes() if G.degree(nid) <= 3)}")
print()

# Group isolated/low-degree nodes by source file
by_file = defaultdict(list)
for nid, deg, nd in low_degree:
    src = nd.get('source_file', 'unknown')
    by_file[src].append((nd.get('label', nid), deg))

print("=== Isolated/near-isolated nodes by source file ===")
for src, items in sorted(by_file.items(), key=lambda x: -len(x[1])):
    labels = [f"{lbl}(deg={d})" for lbl, d in items[:6]]
    print(f"  {src} ({len(items)} nodes): {', '.join(labels)}")

print()
# What are their single connections (for deg=1)?
print("=== Single-edge nodes: what do they connect TO? ===")
deg1 = [(nid, G.nodes[nid]) for nid in G.nodes() if G.degree(nid) == 1]
target_files = defaultdict(list)
for nid, nd in deg1:
    for neighbor in G.neighbors(nid):
        tgt = G.nodes[neighbor].get('source_file', '?')
        target_files[tgt].append(nd.get('label', nid))
    for neighbor in G.predecessors(nid) if G.is_directed() else []:
        pass

for tgt, labels in sorted(target_files.items(), key=lambda x: -len(x[1]))[:8]:
    print(f"  -> {tgt}: {len(labels)} thin nodes hang off it")
    for lbl in labels[:4]:
        print(f"     {lbl}")
