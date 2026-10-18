#!/usr/bin/env python3
"""
gen_depth.py - Frame-by-frame depth inference (Depth Anything V2 Large).

Usage:
    python gen_depth.py <input_frames_dir> <output_frames_dir>

Input:  frame_%08d.png produced by ffmpeg fps-extraction (caller side).
Output: grayscale depth PNGs with the SAME filenames in <output_frames_dir>.

Backend: depth-anything/Depth-Anything-V2-Large-hf via the transformers
depth-estimation pipeline. batch=8, fp16 on CUDA, fp32 on CPU.

The model weights (~1.4 GB) are NOT bundled. On first run transformers
downloads them into $HF_HOME (the caller sets this to a userData subdirectory
so the download persists across sessions instead of refetching every time).
"""
import glob
import os
import sys


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: gen_depth.py <input_frames_dir> <output_frames_dir>\n")
        sys.exit(2)
    in_dir = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    frames = sorted(
        glob.glob(os.path.join(in_dir, "frame_*.png"))
        + glob.glob(os.path.join(in_dir, "frame_*.jpg"))
    )
    if not frames:
        sys.stderr.write("gen_depth: no frames found in {}\n".format(in_dir))
        sys.exit(1)
    total = len(frames)

    # Heavy imports are deferred so a missing torch/transformers fails fast with
    # a clear stderr line that the caller surfaces as "fall back to edges".
    import torch
    from PIL import Image
    from transformers import pipeline as hf_pipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    sys.stderr.write("[gen_depth] device={} dtype={} frames={}\n".format(device, dtype, total))
    sys.stderr.flush()

    pipe = hf_pipeline(
        task="depth-estimation",
        model="depth-anything/Depth-Anything-V2-Large-hf",
        device=device,
        torch_dtype=dtype,
    )

    batch = 8
    for start in range(0, total, batch):
        chunk = frames[start:start + batch]
        images = [Image.open(f).convert("RGB") for f in chunk]
        results = pipe(images, batch_size=len(images))
        for path, res in zip(chunk, results):
            depth_img = res["depth"]
            if depth_img.mode != "L":
                depth_img = depth_img.convert("L")
            depth_img.save(os.path.join(out_dir, os.path.basename(path)))
        done = min(start + batch, total)
        sys.stderr.write("PROGRESS {:.4f}\n".format(done / total))
        sys.stderr.flush()

    sys.stderr.write("[gen_depth] done {} frames\n".format(total))
    sys.stderr.flush()


if __name__ == "__main__":
    main()
