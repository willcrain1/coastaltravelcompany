#!/usr/bin/env python3
"""
ply-to-splat.py -- convert a 3DGS PLY to the .splat binary format.

The .splat format is 32 bytes per Gaussian:
    x, y, z          float32 × 3   (position)
    s0, s1, s2       float32 × 3   (scale, exp'd from log-scale)
    r, g, b, a       uint8   × 4   (colour from SH DC; opacity from logit)
    q0, q1, q2, q3   uint8   × 4   (normalised quaternion × 128 + 128)

Usage:
    python ply-to-splat.py [input.ply [output.splat]]

Defaults:
    input  -- first splat-clean.ply found under export\, else splat.ply
    output -- same folder as input, same stem + .splat
"""

import os
import sys

import numpy as np
from plyfile import PlyData

try:
    import scipy.special
except ImportError:
    sys.exit("scipy not found.  Run: conda run -n nerfstudio pip install scipy")

SH_C0 = 0.28209479177387814   # zeroth-order spherical harmonic coefficient

# ── locate files ──────────────────────────────────────────────────────────────

def _find_default_input():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    export_dir = os.path.join(script_dir, "export")
    for preferred in ("splat-clean.ply", "splat.ply"):
        for root, _dirs, files in os.walk(export_dir):
            if preferred in files:
                return os.path.join(root, preferred)
    return os.path.join(script_dir, "splat.ply")

input_ply = sys.argv[1] if len(sys.argv) > 1 else _find_default_input()
if not os.path.exists(input_ply):
    sys.exit(f"Input not found: {input_ply}")

stem         = os.path.splitext(input_ply)[0]
output_splat = sys.argv[2] if len(sys.argv) > 2 else stem + ".splat"

# ── load ──────────────────────────────────────────────────────────────────────

print(f"\nReading  {input_ply}")
v   = PlyData.read(input_ply)["vertex"].data
n   = len(v)
print(f"  {n:,} Gaussians  ({os.path.getsize(input_ply)/1e6:.1f} MB)")

# ── position (float32) ────────────────────────────────────────────────────────

xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float32)  # (N, 3)

# ── scale: log → actual (float32) ────────────────────────────────────────────

scales = np.stack([
    np.exp(v["scale_0"].astype(np.float32)),
    np.exp(v["scale_1"].astype(np.float32)),
    np.exp(v["scale_2"].astype(np.float32)),
], axis=1)  # (N, 3)

# ── colour: SH DC → uint8 ─────────────────────────────────────────────────────

def sh_to_u8(f_dc):
    return np.clip((0.5 + SH_C0 * f_dc.astype(np.float32)) * 255, 0, 255).astype(np.uint8)

r = sh_to_u8(v["f_dc_0"])
g = sh_to_u8(v["f_dc_1"])
b = sh_to_u8(v["f_dc_2"])

# ── opacity: logit → uint8 ───────────────────────────────────────────────────

a = np.clip(scipy.special.expit(v["opacity"].astype(np.float32)) * 255, 0, 255).astype(np.uint8)

# ── rotation: normalise quaternion → uint8 ───────────────────────────────────

rot = np.stack([
    v["rot_0"].astype(np.float32),
    v["rot_1"].astype(np.float32),
    v["rot_2"].astype(np.float32),
    v["rot_3"].astype(np.float32),
], axis=1)  # (N, 4)

norms     = np.linalg.norm(rot, axis=1, keepdims=True).clip(min=1e-9)
rot_norm  = rot / norms
rot_u8    = np.clip(rot_norm * 128 + 128, 0, 255).astype(np.uint8)  # (N, 4)

# ── pack to 32 bytes / Gaussian ───────────────────────────────────────────────
# Layout: [xyz f32 ×3] [scales f32 ×3] [rgba u8 ×4] [quat u8 ×4]
# Build as raw bytes to avoid numpy alignment padding.

pos_bytes   = xyz.tobytes()                                           # N×12 bytes
scale_bytes = scales.tobytes()                                        # N×12 bytes
rgba_bytes  = np.stack([r, g, b, a], axis=1).tobytes()               # N×4 bytes
rot_bytes   = rot_u8.tobytes()                                        # N×4 bytes

# Interleave the four blocks into N×32 byte rows
pos_arr   = np.frombuffer(pos_bytes,   dtype=np.uint8).reshape(n, 12)
scale_arr = np.frombuffer(scale_bytes, dtype=np.uint8).reshape(n, 12)
rgba_arr  = np.frombuffer(rgba_bytes,  dtype=np.uint8).reshape(n,  4)
rot_arr   = np.frombuffer(rot_bytes,   dtype=np.uint8).reshape(n,  4)

packed = np.concatenate([pos_arr, scale_arr, rgba_arr, rot_arr], axis=1)  # (N, 32)
assert packed.shape == (n, 32), "unexpected packed shape"

# ── write ─────────────────────────────────────────────────────────────────────

print(f"Writing  {output_splat}")
packed.tofile(output_splat)
size_mb = os.path.getsize(output_splat) / 1e6
print(f"Done.  {size_mb:.1f} MB  ({size_mb/os.path.getsize(input_ply)*100:.0f}% of PLY size)\n")
