import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
from collections import defaultdict

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

# Get community 0 nodes
c0_nodes = [nid for nid, d in G.nodes(data=True) if d.get('community') == 0]
print(f"Community 0: {len(c0_nodes)} nodes\n")

# Group by source file
by_file = defaultdict(list)
for nid in c0_nodes:
    d = G.nodes[nid]
    src = d.get('source_file', 'unknown')
    by_file[src].append(d.get('label', nid))

print("=== Nodes by source file ===")
for src, labels in sorted(by_file.items(), key=lambda x: -len(x[1])):
    print(f"\n  {src} ({len(labels)} nodes):")
    for lbl in labels[:12]:
        print(f"    - {lbl}")
    if len(labels) > 12:
        print(f"    ... +{len(labels)-12} more")

# Internal vs external edges
c0_set = set(c0_nodes)
internal = 0
external = defaultdict(int)
for u, v, d in G.edges(data=True):
    if u in c0_set and v in c0_set:
        internal += 1
    elif u in c0_set:
        tgt_comm = G.nodes[v].get('community', '?')
        external[tgt_comm] += 1
    elif v in c0_set:
        src_comm = G.nodes[u].get('community', '?')
        external[src_comm] += 1

print(f"\n=== Edge distribution ===")
print(f"Internal edges (within C0): {internal}")
print(f"External edges by community:")
for comm, count in sorted(external.items(), key=lambda x: -x[1])[:10]:
    print(f"  -> C{comm:02d}: {count} edges")
