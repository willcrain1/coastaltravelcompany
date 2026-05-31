import json
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path

data = json.loads(Path('graphify-out/graph.json').read_text(encoding="utf-8"))
G = json_graph.node_link_graph(data, edges='links')

# Find createJWT node
jwt_nodes = [(nid, d) for nid, d in G.nodes(data=True) if 'createJWT' in d.get('label', '')]
print(f"Found {len(jwt_nodes)} createJWT nodes:")
for nid, d in jwt_nodes:
    print(f"  {nid}: {d.get('label')} [{d.get('source_file','')}] degree={G.degree(nid)}")

print()
# BFS from createJWT to depth 2
for nid, d in jwt_nodes[:1]:
    print(f"=== Connections of {d.get('label')} ===")
    # Get all direct neighbors
    for neighbor in G.neighbors(nid):
        nd = G.nodes[neighbor]
        edge_data = G[nid][neighbor]
        if isinstance(edge_data, dict) and 'relation' not in edge_data:
            # multigraph
            for k, ed in edge_data.items():
                rel = ed.get('relation', '')
                conf = ed.get('confidence', '')
                break
        else:
            rel = edge_data.get('relation', '')
            conf = edge_data.get('confidence', '')
        community = nd.get('community', '?')
        print(f"  --{rel} [{conf}]--> {nd.get('label', neighbor)} | community={community} | {nd.get('source_file','')}")
