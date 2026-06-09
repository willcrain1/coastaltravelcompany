import numpy as np
from plyfile import PlyData
import scipy.special, sys

path = sys.argv[1] if len(sys.argv) > 1 else r"E:\Claude\CTC-Splatting\export\2026-06_home_office\splat.ply"
ply = PlyData.read(path)
v   = ply["vertex"].data

scales  = np.stack([np.exp(v["scale_0"].astype("f4")),
                    np.exp(v["scale_1"].astype("f4")),
                    np.exp(v["scale_2"].astype("f4"))], axis=1)
max_s   = scales.max(axis=1)
opacity = scipy.special.expit(v["opacity"].astype("f4"))

print(f"\nGaussians: {len(v):,}")

print("\n=== MAX SCALE percentiles ===")
for p in [50, 75, 90, 95, 97, 98, 99, 99.5, 99.9, 100]:
    n = (max_s > np.percentile(max_s, p)).sum()
    print(f"  {p:5.1f}th pct = {np.percentile(max_s,p):.5f} m  ({n:,} above)")

print("\n=== Absolute scale thresholds ===")
for t in [0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.00]:
    n = (max_s > t).sum()
    print(f"  max_scale > {t:.2f} m : {n:,}  ({100*n/len(v):.2f}%)")

print("\n=== OPACITY percentiles ===")
for p in [1, 5, 10, 25, 50]:
    print(f"  {p:5.1f}th pct = {np.percentile(opacity,p):.4f}")
print(f"  mean          = {opacity.mean():.4f}")

print("\n=== Opacity thresholds ===")
for t in [0.05, 0.10, 0.15, 0.20, 0.30]:
    n = (opacity < t).sum()
    print(f"  opacity < {t:.2f} : {n:,}  ({100*n/len(v):.2f}%)")
