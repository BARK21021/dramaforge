#!/usr/bin/env python3
"""
gen_face_grid.py - Face-region-only sparse grid overlay.

Takes an input image, detects face(s) using OpenCV DNN SSD (with Haar
cascade fallback), overlays a sparse white-line grid ONLY within the
face bounding box(es), and writes the result as JPEG q88.

Usage:
    python gen_face_grid.py <input> <output> <cells> <opacity> <stroke_width> <model_dir>

Exit codes: 0=success, 10=cv2 not available, 11=image read error, 2=usage error.
"""
import os
import sys

try:
    import cv2
except ImportError:
    sys.stderr.write("cv2 not available\n")
    sys.exit(10)

import numpy as np

MAX_REF_DIMENSION = 1280
DEPLOY_URL = (
    "https://raw.githubusercontent.com/opencv/opencv/master/"
    "samples/dnn/face_detector/deploy.prototxt"
)
CAFFE_URL = (
    "https://github.com/opencv/opencv_3rdparty/raw/"
    "dnn_samples_face_detector_20170830/"
    "res10_300x300_ssd_iter_140000.caffemodel"
)


def download_if_missing(filepath, url):
    if os.path.isfile(filepath) and os.path.getsize(filepath) > 1000:
        return True
    try:
        import urllib.request
        sys.stderr.write(f"Downloading {os.path.basename(filepath)}...\n")
        urllib.request.urlretrieve(url, filepath)
        return os.path.isfile(filepath) and os.path.getsize(filepath) > 1000
    except Exception as exc:
        sys.stderr.write(f"Download failed: {exc}\n")
        return False


def load_dnn_detector(model_dir):
    # Check bundled models first (shipped in resources/face-models/,
    # next to this script's parent dir — no download needed).
    script_dir = os.path.dirname(os.path.abspath(__file__))
    bundled_dir = os.path.join(os.path.dirname(script_dir), "face-models")
    for candidate_dir in [bundled_dir, model_dir]:
        if not candidate_dir:
            continue
        prototxt = os.path.join(candidate_dir, "deploy.prototxt")
        caffemodel = os.path.join(candidate_dir, "res10_300x300_ssd_iter_140000.caffemodel")
        if os.path.isfile(prototxt) and os.path.isfile(caffemodel) and os.path.getsize(caffemodel) > 1000000:
            try:
                return cv2.dnn.readNetFromCaffe(prototxt, caffemodel)
            except Exception as exc:
                sys.stderr.write(f"DNN load failed from {candidate_dir}: {exc}\n")

    # Fallback: download into model_dir (first run on dev machines without bundled models)
    prototxt = os.path.join(model_dir, "deploy.prototxt")
    caffemodel = os.path.join(model_dir, "res10_300x300_ssd_iter_140000.caffemodel")
    if not download_if_missing(prototxt, DEPLOY_URL):
        return None
    if not download_if_missing(caffemodel, CAFFE_URL):
        return None
    try:
        return cv2.dnn.readNetFromCaffe(prototxt, caffemodel)
    except Exception as exc:
        sys.stderr.write(f"DNN load failed: {exc}\n")
        return None
def detect_faces_dnn(net, img):
    h, w = img.shape[:2]
    blob = cv2.dnn.blobFromImage(
        cv2.resize(img, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0)
    )
    net.setInput(blob)
    detections = net.forward()
    faces = []
    for i in range(detections.shape[2]):
        conf = detections[0, 0, i, 2]
        if conf > 0.15:
            box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
            fx, fy, fx2, fy2 = box.astype("int")
            fx, fy = max(0, fx), max(0, fy)
            fx2, fy2 = min(w, fx2), min(h, fy2)
            fw, fh = fx2 - fx, fy2 - fy
            if fw > 30 and fh > 30:
                faces.append((fx, fy, fw, fh))
    return faces


def detect_faces_haar(img):
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    raw = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(50, 50))
    return [(int(x), int(y), int(w), int(h)) for x, y, w, h in raw]


def draw_grid_region(overlay, x, y, w_box, h_box, cells, sw):
    cw = w_box / cells
    ch = h_box / cells
    for i in range(1, cells):
        px = int(x + i * cw)
        cv2.line(overlay, (px, y), (px, y + h_box), (255, 255, 255), sw)
    for i in range(1, cells):
        py = int(y + i * ch)
        cv2.line(overlay, (x, py), (x + w_box, py), (255, 255, 255), sw)


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: gen_face_grid.py <input> <output> [cells] [opacity] [stroke_width] [model_dir]\n")
        sys.exit(2)
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    cells = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    opacity = float(sys.argv[4]) if len(sys.argv) > 4 else 0.6
    stroke_width = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    model_dir = sys.argv[6] if len(sys.argv) > 6 else ""

    img = cv2.imread(input_path)
    if img is None:
        sys.stderr.write(f"cannot read {input_path}\n")
        sys.exit(11)

    h, w = img.shape[:2]
    max_dim = max(w, h)
    if max_dim > MAX_REF_DIMENSION:
        scale = MAX_REF_DIMENSION / max_dim
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]

    faces = []
    net = load_dnn_detector(model_dir) if model_dir else None
    if net is not None:
        faces = detect_faces_dnn(net, img)
        sys.stderr.write(f"DNN faces: {len(faces)}\n")
    if not faces:
        faces = detect_faces_haar(img)
        sys.stderr.write(f"Haar faces: {len(faces)}\n")

    regions = []
    if faces:
        for fx, fy, fw, fh in faces:
            pad_w = int(fw * 0.15)
            pad_h = int(fh * 0.15)
            fx2 = max(0, fx - pad_w)
            fy2 = max(0, fy - pad_h)
            fw2 = min(w - fx2, fw + 2 * pad_w)
            fh2 = min(h - fy2, fh + 2 * pad_h)
            regions.append((fx2, fy2, fw2, fh2))
    else:
        sys.stderr.write("no face detected, full-image grid\n")
        regions = [(0, 0, w, h)]

    grid_overlay = np.zeros_like(img)
    for rx, ry, rw, rh in regions:
        draw_grid_region(grid_overlay, rx, ry, rw, rh, cells, stroke_width)

    mask = cv2.cvtColor(grid_overlay, cv2.COLOR_BGR2GRAY) > 0
    blended = cv2.addWeighted(img, 1 - opacity, np.full_like(img, 255), opacity, 0)
    result = img.copy()
    result[mask] = blended[mask]

    cv2.imwrite(output_path, result, [cv2.IMWRITE_JPEG_QUALITY, 88])
    sys.stderr.write(f"face-grid done: {len(regions)} region(s)\n")


if __name__ == "__main__":
    main()
