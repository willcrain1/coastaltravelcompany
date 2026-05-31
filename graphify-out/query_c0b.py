import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
from collections import defaultdict
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

c0_nodes = set(nid for nid, d in G.nodes(data=True) if d.get('community') == 0)

# What connects utils.js to everything - it's the gravity well
utils_nodes = [nid for nid in c0_nodes if 'utils' in G.nodes[nid].get('source_file','')]
print("utils.js nodes:")
for nid in utils_nodes:
    neighbors = list(G.neighbors(nid))
    files = set(G.nodes[nb].get('source_file','?') for nb in neighbors if nb not in utils_nodes)
    print(f"  {G.nodes[nid].get('label')} -- called from {len(files)} files:")
    for f in sorted(files)[:8]:
        print(f"    {f}")

# Also check router.js
print("\nrouter.js nodes:")
router_nodes = [nid for nid in c0_nodes if 'router' in G.nodes[nid].get('source_file','')]
for nid in router_nodes:
    neighbors = list(G.neighbors(nid))
    files = set(G.nodes[nb].get('source_file','?') for nb in neighbors if 'router' not in G.nodes[nb].get('source_file',''))
    print(f"  {G.nodes[nid].get('label')} -- connected to {len(files)} files")
