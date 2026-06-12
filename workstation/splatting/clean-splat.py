#!/usr/bin/env python3
"""
clean-splat.py -- remove floaters from a 3DGS PLY before .splat conversion.

Four-pass pipeline:
  Pass 1 - Opacity filter   : removes nearly-transparent Gaussians (< MIN_OPACITY).
            Primary source of interior haze and mid-air wisps.
  Pass 2 - Scale filter     : hard cap on maximum Gaussian axis length.
            Oversized blobs are almost always floaters in interior scenes.
  Pass 3 - Auto-crop        : computes the bounding box of high-confidence
            (high-opacity) Gaussians and removes everything outside that box
            plus CROP_PAD metres of padding.  Eliminates outside-room geometry.
  Pass 4 - Statistical outlier removal (SOR): removes Gaussians whose mean
            distance to K nearest neighbours exceeds mean + STD_RATIO * std.
            Catches remaining isolated mid-air blobs.

Usage:
    python clean-splat.py [input.ply [output.ply]] [options]

Key options:
    --min-opacity  float   Opacity threshold, 0-1  (default 0.15)
    --scale-max    float   Hard scale cap in metres (default 0.10)
    --crop-pad     float   Padding beyond geometry bbox in metres (default 1.0)
    --no-crop              Skip the auto-crop pass
    --sor-std      float   SOR aggressiveness; lower = more removed (default 1.2)
    --stats                Print distribution stats and exit without writing
"""

import argparse
import os
import sys

import numpy as np
from plyfile import PlyData, PlyElement

try:
    from scipy.spatial import cKDTree
    import scipy.special
except ImportError:
    sys.exit("scipy not found.  Run: conda run -n nerfstudio pip install scipy")

# ── CLI ────────────────────────────────────────────────────────────────────────

def _find_default_input():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for root, _dirs, files in os.walk(os.path.join(script_dir, "export")):
        for f in files:
            if f == "splat.ply":
                return os.path.join(root, f)
    return os.path.join(script_dir, "splat.ply")

parser = argparse.ArgumentParser(description="Remove floaters from a 3DGS PLY.")
parser.add_argument("input",  nargs="?", default=None)
parser.add_argument("output", nargs="?", default=None)
parser.add_argument("--min-opacity",    type=float, default=0.20,
                    help="Remove Gaussians with sigmoid(opacity) below this (default 0.15)")
parser.add_argument("--scale-max",      type=float, default=0.10,
                    help="Hard cap on max axis length in metres (default 0.10)")
parser.add_argument("--scale-pct",      type=float, default=99.0,
                    help="Also remove above this scale percentile (default 99.0)")
parser.add_argument("--no-crop",        action="store_true",
                    help="Skip the auto-crop bounding-box pass")
parser.add_argument("--crop-pad",       type=float, default=1.0,
                    help="Metres of padding around geometry bbox (default 1.0)")
parser.add_argument("--crop-anchor-opacity", type=float, default=0.5,
                    help="Opacity threshold used to define 'real geometry' for bbox (default 0.5)")
parser.add_argument("--crop-pct",       type=float, default=99.5,
                    help="Percentile used for bbox extents to ignore extreme outliers (default 99.5)")
parser.add_argument("--sor-k",          type=int,   default=20,
                    help="SOR nearest-neighbour count (default 20)")
parser.add_argument("--sor-std",        type=float, default=1.2,
                    help="SOR std-ratio; lower = more aggressive (default 1.2)")
parser.add_argument("--density-radius", type=float, default=0.05,
                    help="Density filter radius in metres (default 0.05)")
parser.add_argument("--density-min",    type=int,   default=10,
                    help="Minimum neighbours within radius to keep a Gaussian (default 10)")
parser.add_argument("--no-density",     action="store_true",
                    help="Skip the density filter pass")
parser.add_argument("--stats",          action="store_true",
                    help="Print distribution info and exit without writing")
args = parser.parse_args()

input_ply  = args.input  or _find_default_input()
output_ply = args.output or os.path.join(
    os.path.dirname(os.path.abspath(input_ply)), "splat-clean.ply")

if not os.path.exists(input_ply):
    sys.exit(f"Input not found: {input_ply}")

# ── load ───────────────────────────────────────────────────────────────────────

print(f"\nReading  {input_ply}")
plydata = PlyData.read(input_ply)
data    = plydata["vertex"].data
n_in    = len(data)
print(f"  {n_in:,} Gaussians  ({os.path.getsize(input_ply)/1e6:.1f} MB)")

xyz     = np.stack([data["x"], data["y"], data["z"]], axis=1)
scales  = np.stack([np.exp(data["scale_0"].astype(np.float32)),
                    np.exp(data["scale_1"].astype(np.float32)),
                    np.exp(data["scale_2"].astype(np.float32))], axis=1)
max_scale = scales.max(axis=1)
opacity   = scipy.special.expit(data["opacity"].astype(np.float32))

# ── stats mode ────────────────────────────────────────────────────────────────

if args.stats:
    print("\n=== MAX SCALE percentiles ===")
    for p in [50, 90, 95, 97, 98, 99, 99.5, 99.9]:
        n = int((max_scale > np.percentile(max_scale, p)).sum())
        print(f"  {p:5.1f}th pct = {np.percentile(max_scale,p):.5f} m  ({n:,} above)")
    print("\n=== Absolute scale thresholds ===")
    for t in [0.05, 0.10, 0.15, 0.20, 0.50]:
        n = int((max_scale > t).sum())
        print(f"  > {t:.2f} m : {n:,}  ({100*n/n_in:.2f}%)")
    print("\n=== Opacity thresholds ===")
    for t in [0.05, 0.10, 0.15, 0.20, 0.30]:
        n = int((opacity < t).sum())
        print(f"  < {t:.2f} : {n:,}  ({100*n/n_in:.2f}%)")
    sys.exit(0)

mask = np.ones(n_in, dtype=bool)

# ── pass 1: opacity filter ─────────────────────────────────────────────────────

op_mask      = opacity >= args.min_opacity
removed_opac = int((~op_mask).sum())
mask        &= op_mask
print(f"\nPass 1 -- opacity filter  (< {args.min_opacity})")
print(f"  Removed : {removed_opac:,}  ({100*removed_opac/n_in:.1f}%)")

# ── pass 2: scale filter ───────────────────────────────────────────────────────

pct_thresh    = np.percentile(max_scale, args.scale_pct)
effective_cap = min(args.scale_max, pct_thresh)
scale_mask    = max_scale <= effective_cap
removed_scale = int((mask & ~scale_mask).sum())
mask         &= scale_mask
print(f"\nPass 2 -- scale filter  (cap {effective_cap:.4f} m)")
print(f"  Removed : {removed_scale:,}  ({100*removed_scale/n_in:.1f}%)")

# ── pass 3: auto-crop bounding box ────────────────────────────────────────────

if not args.no_crop:
    # Use only high-opacity Gaussians to define the "real geometry" extent
    anchor_mask = opacity >= args.crop_anchor_opacity
    n_anchor    = int(anchor_mask.sum())
    print(f"\nPass 3 -- auto-crop  (bbox of {n_anchor:,} high-opacity Gaussians"
          f" ≥ {args.crop_anchor_opacity}, + {args.crop_pad} m padding)")

    if n_anchor < 1000:
        print("  WARNING: too few anchor Gaussians — skipping crop pass")
    else:
        anchor_xyz = xyz[anchor_mask]
        # Use percentile extents so a handful of extreme outliers don't inflate the box
        lo_pct = 100 - args.crop_pct
        lo  = np.percentile(anchor_xyz, lo_pct,   axis=0) - args.crop_pad
        hi  = np.percentile(anchor_xyz, args.crop_pct, axis=0) + args.crop_pad
        print(f"  Bbox  X: [{lo[0]:.2f}, {hi[0]:.2f}]  "
              f"Y: [{lo[1]:.2f}, {hi[1]:.2f}]  "
              f"Z: [{lo[2]:.2f}, {hi[2]:.2f}]")
        crop_mask    = np.all((xyz >= lo) & (xyz <= hi), axis=1)
        removed_crop = int((mask & ~crop_mask).sum())
        mask        &= crop_mask
        print(f"  Removed : {removed_crop:,}  ({100*removed_crop/n_in:.1f}%)")
else:
    print("\nPass 3 -- auto-crop  (skipped)")

# ── pass 4: statistical outlier removal ───────────────────────────────────────

n_pre_sor = int(mask.sum())
print(f"\nPass 4 -- statistical outlier removal  (K={args.sor_k}, std_ratio={args.sor_std})")
print(f"  Building KD-tree on {n_pre_sor:,} Gaussians ...")

xyz_kept     = xyz[mask]
tree         = cKDTree(xyz_kept)
dists, _     = tree.query(xyz_kept, k=args.sor_k + 1, workers=-1)
mean_dist    = dists[:, 1:].mean(axis=1)
global_mean  = mean_dist.mean()
global_std   = mean_dist.std()
sor_thresh   = global_mean + args.sor_std * global_std
sor_mask     = mean_dist <= sor_thresh
removed_sor  = int((~sor_mask).sum())

indices_kept = np.where(mask)[0]
mask[indices_kept[~sor_mask]] = False

print(f"  Mean neighbour dist : {global_mean:.5f} m  →  cutoff {sor_thresh:.5f} m")
print(f"  Removed : {removed_sor:,}  ({100*removed_sor/n_in:.1f}%)")

# ── pass 5: density filter ────────────────────────────────────────────────────
# Catches clustered floaters that SOR misses because they look dense internally.
# Surface Gaussians sit in tight sheets with many neighbours; air blobs are sparse.

if not args.no_density:
    n_pre_density = int(mask.sum())
    print(f"\nPass 5 -- density filter  (radius={args.density_radius} m, min_neighbours={args.density_min})")
    print(f"  Querying {n_pre_density:,} Gaussians ...")
    xyz_kept     = xyz[mask]
    tree         = cKDTree(xyz_kept)
    counts       = tree.query_ball_point(xyz_kept, r=args.density_radius, return_length=True, workers=-1)
    # subtract 1 to exclude self
    density_mask  = (counts - 1) >= args.density_min
    removed_dens  = int((~density_mask).sum())
    indices_kept  = np.where(mask)[0]
    mask[indices_kept[~density_mask]] = False
    print(f"  Removed : {removed_dens:,}  ({100*removed_dens/n_in:.1f}%)")
else:
    print("\nPass 5 -- density filter  (skipped)")

# ── summary ────────────────────────────────────────────────────────────────────

n_out         = int(mask.sum())
total_removed = n_in - n_out
print(f"\n{'='*52}")
print(f"  Input    : {n_in:,}")
print(f"  Removed  : {total_removed:,}  ({100*total_removed/n_in:.1f}%)")
print(f"  Output   : {n_out:,}")
print(f"{'='*52}")

# ── write ──────────────────────────────────────────────────────────────────────

print(f"\nWriting  {output_ply} ...")
PlyData([PlyElement.describe(data[mask], "vertex")], text=False).write(output_ply)
print(f"Done.  {os.path.getsize(output_ply)/1e6:.1f} MB\n")
