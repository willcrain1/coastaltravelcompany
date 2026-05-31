import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
from collections import defaultdict

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

c0_nodes = set(nid for nid, d in G.nodes(data=True) if d.get('community') == 0)

# What do the internal edges look like - which SOURCE files connect to which other source files?
file_to_file = defaultdict(lambda: defaultdict(int))
for u, v, d in G.edges(data=True):
    if u in c0_nodes and v in c0_nodes:
        src_file = G.nodes[u].get('source_file', '?')
        tgt_file = G.nodes[v].get('source_file', '?')
        if src_file != tgt_file:
            file_to_file[src_file][tgt_file] += 1

# How many internal cross-file edges does each file have?
print("=== Cross-file edges WITHIN C0 (which files pull others in) ===")
# Find gravity centers - files that are imported by many others
incoming = defaultdict(int)
for src, targets in file_to_file.items():
    for tgt, cnt in targets.items():
        incoming[tgt] += cnt

for tgt, cnt in sorted(incoming.items(), key=lambda x: -x[1])[:12]:
    print(f"  {tgt}: pulled in by {cnt} cross-file edges")

print()
# Check which files in C0 also have edges to the god nodes
print("=== God node cross-file connections within C0 ===")
god_nodes = ['src_utils_jsonresponse', 'src_router_handlerequest', 'src_jwt_getauth', 'src_auth_authrequired', 'src_jwt_createjwt']
for gn in god_nodes:
    if gn in G.nodes:
        label = G.nodes[gn].get('label', gn)
        src_file = G.nodes[gn].get('source_file', '?')
        neighbors_in_c0 = [G.nodes[nb].get('source_file','?') for nb in G.neighbors(gn) if nb in c0_nodes]
        unique_files = set(f for f in neighbors_in_c0 if f != src_file)
        print(f"  {label} ({src_file}) → {len(unique_files)} other files in C0: {sorted(unique_files)[:5]}")
