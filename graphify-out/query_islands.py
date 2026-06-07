import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
from collections import defaultdict
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

components = sorted(nx.connected_components(G), key=len, reverse=True)
print(f"37 components. Largest: {len(components[0])} nodes. Rest:\n")

for i, comp in enumerate(components[1:], 1):
    files = set(G.nodes[nid].get('source_file','?') for nid in comp)
    sample_labels = [G.nodes[nid].get('label', nid) for nid in list(comp)[:3]]
    print(f"  Island {i:02d} ({len(comp):3d} nodes) | files: {sorted(files)[:2]}")
    print(f"           sample: {', '.join(sample_labels[:3])}")
