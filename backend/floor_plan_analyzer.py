"""
floor_plan_analyzer.py  —  Stage-1 Pre-Processor
==================================================

Analyses a raw, user-uploaded floor plan image and produces a **clean
intermediate PNG** that the existing Stage-2 detectors (wall_detector.py,
feature_extractor.py) can process with high accuracy.

Pipeline:
  1. Auto-crop ROI  (strip title bars, legends, borders)
  2. Build wall mask (Otsu auto-threshold, morphology clean-up)
  3. Detect wall lines at ANY angle via HoughLinesP
  4. Merge collinear wall segments (supports diagonals)
  5. Snap corners + close outer boundary
  6. Detect windows (thin-line morphology, snap to nearest wall)
  7. Detect doors  (arc contour analysis, circle-fit)
  8. Render clean PNG  (thick black walls, gray windows/doors, white bg)

Usage:
    from floor_plan_analyzer import preprocess_floor_plan
    clean_path = preprocess_floor_plan("test/uploaded.png")
    # clean_path → "test/clean_uploaded.png"
"""

import cv2
import numpy as np
import math
import os


# ═══════════════════════════════════════════════════════════════════════
#  CONSTANTS
# ═══════════════════════════════════════════════════════════════════════

# Wall rendering
WALL_DRAW_THICKNESS = 12       # px – thickness of redrawn walls in clean image
WALL_COLOR          = 0        # grayscale black

# Window rendering (must be lighter than wall threshold 80 and darker than
# the binary threshold 200 used by detect_windows_json)
WINDOW_COLOR        = 150      # gray
WINDOW_DRAW_THICK   = 2        # px – thin double-line symbol

# Door rendering
DOOR_COLOR          = 150      # gray
DOOR_DRAW_THICK     = 2        # px

# Detection tolerances
CORNER_SNAP_PX      = 15       # px – endpoints closer than this are merged
MERGE_TRACK_TOL     = 8        # px – max perpendicular distance to merge
MERGE_GAP_TOL       = 60       # px – max endpoint gap to merge
MERGE_ANGLE_TOL     = 8        # degrees – max angle difference to merge
WIN_SNAP_DIST       = 35       # px – max distance for window→wall snap
DOOR_MIN_AREA       = 40       # px² – minimum arc contour area


# ═══════════════════════════════════════════════════════════════════════
#  STEP 1 – ROI DETECTION  (strip title bars, legends, borders)
# ═══════════════════════════════════════════════════════════════════════

def _find_roi(img):
    """
    Detect and exclude uniform-colour horizontal bands (title bars, captions)
    and large uniform borders.  Returns (x, y, w, h) of the floor plan ROI.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    # --- Detect horizontal bands of near-uniform colour ---
    # A title bar row has very low variance across its width.
    row_std = np.std(gray, axis=1)  # standard deviation per row
    # Rows with std < 25 AND mean < 200 (not white) are "uniform dark bands"
    row_mean = np.mean(gray, axis=1)
    is_banner = (row_std < 25) & (row_mean < 200)

    # Find the largest contiguous block of non-banner rows
    # (the actual floor plan content)
    in_content = False
    best_start, best_end = 0, h
    cur_start = 0
    best_len = 0

    for r in range(h):
        if not is_banner[r]:
            if not in_content:
                cur_start = r
                in_content = True
        else:
            if in_content:
                length = r - cur_start
                if length > best_len:
                    best_len = length
                    best_start, best_end = cur_start, r
                in_content = False
    if in_content:
        length = h - cur_start
        if length > best_len:
            best_start, best_end = cur_start, h

    # --- Trim white borders ---
    roi_gray = gray[best_start:best_end, :]

    # Find bounding box of non-white pixels
    non_white = roi_gray < 240
    rows_with_content = np.any(non_white, axis=1)
    cols_with_content = np.any(non_white, axis=0)

    if not np.any(rows_with_content) or not np.any(cols_with_content):
        # Fallback: entire image
        return 0, 0, w, h

    r_min = np.argmax(rows_with_content)
    r_max = h - 1 - np.argmax(rows_with_content[::-1])  # relative to roi_gray
    r_max = len(rows_with_content) - 1 - np.argmax(rows_with_content[::-1])
    c_min = np.argmax(cols_with_content)
    c_max = len(cols_with_content) - 1 - np.argmax(cols_with_content[::-1])

    # Add small padding
    pad = 5
    r_min = max(0, r_min - pad)
    r_max = min(best_end - best_start - 1, r_max + pad)
    c_min = max(0, c_min - pad)
    c_max = min(w - 1, c_max + pad)

    return c_min, best_start + r_min, c_max - c_min + 1, r_max - r_min + 1


# ═══════════════════════════════════════════════════════════════════════
#  STEP 2 – WALL MASK  (Otsu auto-threshold + morphology)
# ═══════════════════════════════════════════════════════════════════════

def _make_wall_mask(gray):
    """
    Create a binary mask of wall pixels using Otsu's method.
    Otsu automatically picks the best threshold for the image's histogram,
    unlike the hardcoded threshold=80 in the old detector.
    """
    # Blur slightly to reduce noise
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)

    # Otsu's method: automatically finds the optimal threshold
    thresh_val, mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Morphological clean-up
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    # Remove small noise blobs (keep only components > 80px area)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] > 80:
            clean[labels == i] = 255

    return clean


# ═══════════════════════════════════════════════════════════════════════
#  STEP 3 – WALL LINE DETECTION  (HoughLinesP, supporting ALL angles)
# ═══════════════════════════════════════════════════════════════════════

def _detect_lines(wall_mask):
    """
    Detect wall centre-lines using HoughLinesP on a skeletonized mask.
    """
    # Skeletonize to get centre-lines
    if hasattr(cv2, 'ximgproc'):
        skeleton = cv2.ximgproc.thinning(wall_mask)
    else:
        skeleton = wall_mask  # fallback: use raw mask

    lines = cv2.HoughLinesP(
        skeleton, rho=1, theta=np.pi / 180,
        threshold=20, minLineLength=15, maxLineGap=30
    )

    if lines is None:
        return []

    return [list(l[0]) for l in lines]


# ═══════════════════════════════════════════════════════════════════════
#  STEP 4 – MERGE COLLINEAR SEGMENTS  (supports diagonals)
# ═══════════════════════════════════════════════════════════════════════

def _line_angle(line):
    """Angle in degrees (0–180) of a line segment."""
    x1, y1, x2, y2 = line
    return math.degrees(math.atan2(abs(y2 - y1), abs(x2 - x1)))


def _perpendicular_distance(px, py, x1, y1, x2, y2):
    """Distance from point (px,py) to infinite line through (x1,y1)→(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length = math.sqrt(dx * dx + dy * dy)
    if length < 0.001:
        return math.hypot(px - x1, py - y1)
    return abs(dx * (y1 - py) - dy * (x1 - px)) / length


def _project_onto_line(px, py, x1, y1, x2, y2):
    """Project point onto line, return parameter t (0=start, 1=end)."""
    dx, dy = x2 - x1, y2 - y1
    len_sq = dx * dx + dy * dy
    if len_sq < 0.001:
        return 0.0
    return ((px - x1) * dx + (py - y1) * dy) / len_sq


def _should_merge(w1, w2):
    """
    Check if two line segments can be merged.  Supports ANY angle.
    Returns (can_merge: bool, merged_line: list|None).
    """
    a1 = _line_angle(w1)
    a2 = _line_angle(w2)

    # Angle difference (handle wrap-around at 0/180)
    angle_diff = abs(a1 - a2)
    if angle_diff > 90:
        angle_diff = 180 - angle_diff
    if angle_diff > MERGE_ANGLE_TOL:
        return False, None

    x1a, y1a, x2a, y2a = w1
    x1b, y1b, x2b, y2b = w2

    # Both endpoints of w2 must be within MERGE_TRACK_TOL of the infinite
    # line defined by w1 (perpendicular distance check)
    d1 = _perpendicular_distance(x1b, y1b, x1a, y1a, x2a, y2a)
    d2 = _perpendicular_distance(x2b, y2b, x1a, y1a, x2a, y2a)
    if d1 > MERGE_TRACK_TOL or d2 > MERGE_TRACK_TOL:
        return False, None

    # Project all 4 endpoints onto w1's direction to check overlap/gap
    t_vals = [
        0.0,  # w1 start
        1.0,  # w1 end
        _project_onto_line(x1b, y1b, x1a, y1a, x2a, y2a),
        _project_onto_line(x2b, y2b, x1a, y1a, x2a, y2a),
    ]

    t_min = min(t_vals)
    t_max = max(t_vals)

    # Check if segments overlap or are close enough
    w1_len = math.hypot(x2a - x1a, y2a - y1a)
    gap = 0
    # If segments don't overlap, calculate gap in pixels
    t_w2_min = min(t_vals[2], t_vals[3])
    t_w2_max = max(t_vals[2], t_vals[3])
    if t_w2_min > 1.0:
        gap = (t_w2_min - 1.0) * w1_len
    elif t_w2_max < 0.0:
        gap = abs(t_w2_max) * w1_len

    if gap > MERGE_GAP_TOL:
        return False, None

    # Merge: extend to cover the full range
    dx, dy = x2a - x1a, y2a - y1a
    merged = [
        int(round(x1a + dx * t_min)),
        int(round(y1a + dy * t_min)),
        int(round(x1a + dx * t_max)),
        int(round(y1a + dy * t_max)),
    ]
    return True, merged


def _merge_lines(lines):
    """Iteratively merge collinear line segments until stable."""
    merged = [list(l) for l in lines]
    changed = True
    while changed:
        changed = False
        new_merged = []
        skip = set()
        for i in range(len(merged)):
            if i in skip:
                continue
            current = merged[i]
            for j in range(i + 1, len(merged)):
                if j in skip:
                    continue
                can, result = _should_merge(current, merged[j])
                if can:
                    current = result
                    skip.add(j)
                    changed = True
            new_merged.append(current)
        merged = new_merged
    return merged


# ═══════════════════════════════════════════════════════════════════════
#  STEP 5 – CORNER SNAP + OUTER BOUNDARY CLOSURE
# ═══════════════════════════════════════════════════════════════════════

def _snap_corners(walls):
    """Snap nearby endpoints together iteratively until stable."""
    changed = True
    while changed:
        changed = False
        eps = []
        for wi, wall in enumerate(walls):
            eps.append((wi, 0, wall[0], wall[1]))  # start
            eps.append((wi, 1, wall[2], wall[3]))  # end

        for i in range(len(eps)):
            wi, ei, xi, yi = eps[i]
            for j in range(i + 1, len(eps)):
                wj, ej, xj, yj = eps[j]
                if wi == wj:
                    continue
                d = math.hypot(xi - xj, yi - yj)
                if 0 < d < CORNER_SNAP_PX:
                    mx = int(round((xi + xj) / 2))
                    my = int(round((yi + yj) / 2))
                    if ei == 0:
                        walls[wi][0], walls[wi][1] = mx, my
                    else:
                        walls[wi][2], walls[wi][3] = mx, my
                    if ej == 0:
                        walls[wj][0], walls[wj][1] = mx, my
                    else:
                        walls[wj][2], walls[wj][3] = mx, my
                    changed = True
                    break
            if changed:
                break
    return walls


def _close_outer_boundary(walls, wall_mask):
    """
    Extract outer contour of the wall mask and ensure every edge of
    the perimeter appears in the wall list.
    Supports diagonal edges — does NOT force them to H/V.
    """
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(wall_mask, cv2.MORPH_CLOSE, kernel)
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return walls

    main_cnt = max(cnts, key=cv2.contourArea)
    peri = cv2.arcLength(main_cnt, True)
    approx = cv2.approxPolyDP(main_cnt, 0.005 * peri, True)
    pts = [tuple(p[0]) for p in approx]

    if len(pts) < 3:
        return walls

    OUTER_SNAP = 8

    def _angle_deg(line):
        dx = abs(line[2] - line[0])
        dy = abs(line[3] - line[1])
        return math.degrees(math.atan2(dy, dx))

    outer_edges = []
    for k in range(len(pts)):
        p1 = pts[k]
        p2 = pts[(k + 1) % len(pts)]
        edge = [int(p1[0]), int(p1[1]), int(p2[0]), int(p2[1])]
        edge_len = math.hypot(edge[2] - edge[0], edge[3] - edge[1])
        if edge_len < 10:
            continue

        # Snap near-orthogonal edges to exact H/V, but leave diagonals alone
        angle = _angle_deg(edge)
        if angle < 10:
            # Nearly horizontal
            mid_y = int(round((edge[1] + edge[3]) / 2))
            edge = [min(edge[0], edge[2]), mid_y, max(edge[0], edge[2]), mid_y]
        elif angle > 80:
            # Nearly vertical
            mid_x = int(round((edge[0] + edge[2]) / 2))
            edge = [mid_x, min(edge[1], edge[3]), mid_x, max(edge[1], edge[3])]
        # else: diagonal — keep as-is

        outer_edges.append(edge)

    # Check coverage against existing walls
    def _covers(existing, edge):
        # Quick check: angles must be similar
        a1 = _angle_deg(existing)
        a2 = _angle_deg(edge)
        diff = abs(a1 - a2)
        if diff > 90:
            diff = 180 - diff
        if diff > 15:
            return False

        # Perpendicular distance between the two lines
        mx = (edge[0] + edge[2]) / 2
        my = (edge[1] + edge[3]) / 2
        d = _perpendicular_distance(mx, my, existing[0], existing[1], existing[2], existing[3])
        if d > OUTER_SNAP:
            return False

        # Check overlap along the line direction
        t1 = _project_onto_line(edge[0], edge[1], existing[0], existing[1], existing[2], existing[3])
        t2 = _project_onto_line(edge[2], edge[3], existing[0], existing[1], existing[2], existing[3])
        t_min, t_max = min(t1, t2), max(t1, t2)
        overlap = max(0, min(1, t_max) - max(0, t_min))
        return overlap > 0.5

    for edge in outer_edges:
        covered = any(_covers(w, edge) for w in walls)
        if not covered:
            walls.append(edge)

    # Final corner snap after injecting boundary edges
    walls = _snap_corners(walls)
    return walls


# ═══════════════════════════════════════════════════════════════════════
#  STEP 6 – WINDOW DETECTION  (thin-line morphology, snap to wall)
# ═══════════════════════════════════════════════════════════════════════

def _extract_windows(gray, wall_mask, walls):
    """
    Detect window symbols (thin parallel lines on walls) and snap them
    to the nearest wall centre-line.

    Returns list of:
      { "start": (x,y), "end": (x,y), "width": px, "wall_idx": int, "pos_t": float }
    """
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    # Extract thin horizontal and vertical lines
    v_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 12))
    h_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (12, 1))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kern)
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kern)

    # Subtract wall bulk to isolate window lines
    fat_walls = cv2.dilate(wall_mask, np.ones((2, 2), np.uint8), iterations=1)
    win_mask = cv2.subtract(cv2.bitwise_or(v_lines, h_lines), fat_walls)
    win_mask = cv2.morphologyEx(win_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    # Outer-wall filter: only keep windows near the main outer shell
    cnts, _ = cv2.findContours(wall_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        ribbon = np.zeros_like(win_mask)
        main_shell = max(cnts, key=cv2.contourArea)
        cv2.drawContours(ribbon, [main_shell], -1, 255, thickness=40)
        win_mask = cv2.bitwise_and(win_mask, ribbon)

    # Vectorize via Hough
    lines = cv2.HoughLinesP(win_mask, 1, np.pi / 180, 15, minLineLength=10, maxLineGap=5)
    if lines is None:
        return [], win_mask

    windows = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        # Snap to 90° for window symbols (windows ARE always H or V in any floor plan)
        if abs(y1 - y2) < abs(x1 - x2):
            y2 = y1
        else:
            x2 = x1

        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        width = int(math.hypot(x2 - x1, y2 - y1))

        # Find nearest wall
        best_dist = WIN_SNAP_DIST
        best_wall_idx = -1
        best_pos_t = 0.5

        for wi, wall in enumerate(walls):
            wx1, wy1, wx2, wy2 = wall
            d = _point_to_segment_dist(mx, my, wx1, wy1, wx2, wy2)
            if d < best_dist:
                best_dist = d
                best_wall_idx = wi
                best_pos_t = _project_onto_line(mx, my, wx1, wy1, wx2, wy2)
                best_pos_t = max(0, min(1, best_pos_t))

        if best_wall_idx >= 0:
            windows.append({
                "start": (int(x1), int(y1)),
                "end": (int(x2), int(y2)),
                "width": width,
                "wall_idx": best_wall_idx,
                "pos_t": best_pos_t,
            })

    return windows, win_mask


def _point_to_segment_dist(px, py, x1, y1, x2, y2):
    """Distance from point to a finite line segment."""
    dx, dy = x2 - x1, y2 - y1
    len_sq = dx * dx + dy * dy
    if len_sq < 0.001:
        return math.hypot(px - x1, py - y1)
    t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / len_sq))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(px - proj_x, py - proj_y)


# ═══════════════════════════════════════════════════════════════════════
#  STEP 7 – DOOR DETECTION  (arc contours, circle-fit)
# ═══════════════════════════════════════════════════════════════════════

def _fit_circle(points):
    """
    Algebraic least-squares circle fit (Kåsa method).
    Given Nx2 array of (x,y) points, returns (cx, cy, radius).
    """
    x = points[:, 0].astype(np.float64)
    y = points[:, 1].astype(np.float64)
    n = len(x)
    if n < 3:
        return None

    # Build system:  [x  y  1] * [A, B, C]^T = [x² + y²]
    A_mat = np.column_stack([x, y, np.ones(n)])
    b_vec = x * x + y * y
    try:
        result, _, _, _ = np.linalg.lstsq(A_mat, b_vec, rcond=None)
    except np.linalg.LinAlgError:
        return None

    cx = result[0] / 2.0
    cy = result[1] / 2.0
    r_sq = result[2] + cx * cx + cy * cy
    if r_sq <= 0:
        return None
    return (cx, cy, math.sqrt(r_sq))


def _determine_quadrant(cx, cy, bbox):
    """
    Determine which 90° quadrant an arc occupies relative to its
    fitted circle centre.  Returns (start_angle, end_angle) in degrees
    for cv2.ellipse (measured clockwise from +X axis).

    The hinge (circle centre) is at one corner of the bounding box.
    We figure out which corner by checking which bbox corner is
    closest to the fitted centre.
    """
    bx, by, bw, bh = bbox

    corners = [
        (bx,      by),       # top-left
        (bx + bw, by),       # top-right
        (bx,      by + bh),  # bottom-left
        (bx + bw, by + bh),  # bottom-right
    ]
    dists = [math.hypot(cx - cx2, cy - cy2) for cx2, cy2 in corners]
    closest = int(np.argmin(dists))

    # Map corner → arc quadrant  (cv2.ellipse uses clockwise angles)
    #    closest=0  TL → arc sweeps right and down  →  0°–90°
    #    closest=1  TR → arc sweeps down and left   → 90°–180°
    #    closest=2  BL → arc sweeps up and right    → 270°–360°
    #    closest=3  BR → arc sweeps left and up     → 180°–270°
    quadrant_map = {
        0: (0,   90),
        1: (90,  180),
        2: (270, 360),
        3: (180, 270),
    }
    return quadrant_map[closest], corners[closest]


def _extract_doors(gray, wall_mask):
    """
    Detect door arcs using a robust multi-step approach:
      1. Global threshold (210) to capture thin arc lines
      2. Subtract eroded wall core (preserves arc pixels near walls)
      3. GaussianBlur + re-threshold "healing" (reconnects broken arcs)
      4. Large-kernel line removal (20px) to isolate arcs
      5. Contour filtering by solidity and aspect ratio
      6. Algebraic circle fitting per arc for precise geometry

    Returns list of:
      { "center": (x,y), "radius": int, "start_angle": int,
        "end_angle": int, "hinge": (x,y), "bbox": (x,y,w,h) }
    """
    # Step 1: Global threshold
    _, binary = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY_INV)

    # Step 2: Subtract wall core (eroded — preserves arc pixels near walls)
    wall_core = cv2.erode(wall_mask, np.ones((3, 3), np.uint8), iterations=1)
    details = cv2.subtract(binary, wall_core)

    # Step 3: Heal broken arc fragments
    blurred = cv2.GaussianBlur(details, (9, 9), 0)
    _, healed = cv2.threshold(blurred, 50, 255, cv2.THRESH_BINARY)

    # Step 4: Remove straight lines (20px kernels)
    h_k = cv2.getStructuringElement(cv2.MORPH_RECT, (20, 1))
    v_k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 20))
    lines_found = cv2.add(
        cv2.morphologyEx(healed, cv2.MORPH_OPEN, h_k),
        cv2.morphologyEx(healed, cv2.MORPH_OPEN, v_k)
    )
    arcs_only = cv2.subtract(healed, lines_found)

    # Step 5: Contour analysis
    cnts, _ = cv2.findContours(arcs_only, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    doors = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < 15:
            continue

        x, y, gw, gh = cv2.boundingRect(c)
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = float(area) / hull_area if hull_area > 0 else 0
        extent = float(area) / (gw * gh) if gw * gh > 0 else 0
        aspect = float(gw) / gh if gh > 0 else 0

        if 0.2 < aspect < 5.0 and solidity < 0.65 and extent < 0.55:
            # Step 6: Circle fit on contour points
            pts = c.reshape(-1, 2)
            fit = _fit_circle(pts)
            if fit is None:
                continue

            cx, cy, radius = fit
            radius = int(round(radius))
            if radius < 5 or radius > max(gw, gh) * 3:
                continue  # bad fit

            bbox = (x, y, gw, gh)
            (start_angle, end_angle), hinge = _determine_quadrant(cx, cy, bbox)

            doors.append({
                "center": (int(round(cx)), int(round(cy))),
                "radius": radius,
                "start_angle": start_angle,
                "end_angle": end_angle,
                "hinge": hinge,
                "bbox": bbox,
            })

    return doors, arcs_only


# ═══════════════════════════════════════════════════════════════════════
#  STEP 8 – RENDER CLEAN PNG
# ═══════════════════════════════════════════════════════════════════════

def _render_clean_image(width, height, walls, windows, doors):
    """
    Draw a precise, CAD-quality floor plan image that the Stage-2
    detectors (wall_detector.py, feature_extractor.py) will process
    reliably.

    Drawing rules:
      - Background: pure white (255)
      - Walls: solid black (0), anti-aliased, uniform thickness
      - Windows: gray (WINDOW_COLOR) precise parallel double-lines
      - Doors: gray (DOOR_COLOR) mathematically perfect quarter-circle arcs
               drawn from fitted circle centre + radius
    """
    canvas = np.full((height, width), 255, dtype=np.uint8)

    # ── Draw walls ──────────────────────────────────────────────────
    # Use LINE_AA for crisp anti-aliased lines
    for wall in walls:
        x1, y1, x2, y2 = wall
        pt1 = (int(round(x1)), int(round(y1)))
        pt2 = (int(round(x2)), int(round(y2)))
        cv2.line(canvas, pt1, pt2, WALL_COLOR, WALL_DRAW_THICKNESS, cv2.LINE_AA)

    # ── Draw windows ────────────────────────────────────────────────
    # Each window = two thin parallel lines offset ±3px from centre-line
    WINDOW_OFFSET = 3  # px offset from centre-line for double-line symbol
    for win in windows:
        sx, sy = win["start"]
        ex, ey = win["end"]

        dx = float(ex - sx)
        dy = float(ey - sy)
        length = math.hypot(dx, dy)
        if length < 1:
            continue

        # Unit normal (perpendicular to window direction)
        nx = -dy / length * WINDOW_OFFSET
        ny =  dx / length * WINDOW_OFFSET

        # Two perfectly parallel lines, symmetrically offset
        cv2.line(canvas,
                 (int(round(sx + nx)), int(round(sy + ny))),
                 (int(round(ex + nx)), int(round(ey + ny))),
                 WINDOW_COLOR, WINDOW_DRAW_THICK, cv2.LINE_AA)
        cv2.line(canvas,
                 (int(round(sx - nx)), int(round(sy - ny))),
                 (int(round(ex - nx)), int(round(ey - ny))),
                 WINDOW_COLOR, WINDOW_DRAW_THICK, cv2.LINE_AA)

    # ── Draw doors ──────────────────────────────────────────────────
    # Each door uses the fitted circle centre + radius → perfect arc
    for door in doors:
        center = door["center"]
        radius = door["radius"]
        start_angle = door["start_angle"]
        end_angle = door["end_angle"]

        # cv2.ellipse draws a perfect arc from the mathematical parameters
        cv2.ellipse(canvas,
                    center,                    # exact fitted centre
                    (radius, radius),          # both axes = radius (circle)
                    0,                         # no rotation
                    start_angle, end_angle,    # quadrant from circle fit
                    DOOR_COLOR,
                    DOOR_DRAW_THICK,
                    cv2.LINE_AA)               # anti-aliased

    return canvas


# ═══════════════════════════════════════════════════════════════════════
#  PUBLIC API
# ═══════════════════════════════════════════════════════════════════════

def preprocess_floor_plan(image_path):
    """
    Main entry point.  Analyses the raw floor plan image and writes a
    clean intermediate PNG.

    Args:
        image_path: path to the raw user-uploaded image

    Returns:
        clean_path: path to the generated clean PNG
        (saved as  test/clean_<original_name>.png)
    """
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")

    # Step 1: Find ROI (crop title bars, legends)
    rx, ry, rw, rh = _find_roi(img)
    roi = img[ry:ry + rh, rx:rx + rw]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    print(f"[Analyzer] ROI: ({rx},{ry}) {rw}×{rh}  (original {img.shape[1]}×{img.shape[0]})")

    # Step 2: Wall mask
    wall_mask = _make_wall_mask(gray)

    # Step 3: Detect wall lines
    raw_lines = _detect_lines(wall_mask)
    print(f"[Analyzer] Raw Hough lines: {len(raw_lines)}")

    # Step 4: Merge collinear segments
    walls = _merge_lines(raw_lines)
    print(f"[Analyzer] Merged walls: {len(walls)}")

    # Step 5: Snap corners + close boundary
    walls = _snap_corners(walls)
    walls = _close_outer_boundary(walls, wall_mask)

    # Remove degenerate zero-length walls
    walls = [w for w in walls if math.hypot(w[2] - w[0], w[3] - w[1]) > 5]
    print(f"[Analyzer] Final walls (after snap + boundary): {len(walls)}")

    # Step 6: Windows
    windows, _ = _extract_windows(gray, wall_mask, walls)
    print(f"[Analyzer] Windows found: {len(windows)}")

    # Step 7: Doors
    doors, _ = _extract_doors(gray, wall_mask)
    print(f"[Analyzer] Doors found: {len(doors)}")

    # Step 8: Render clean image
    clean = _render_clean_image(rw, rh, walls, windows, doors)

    # Save output
    dir_name = os.path.dirname(image_path)
    base_name = os.path.basename(image_path)
    clean_name = f"clean_{base_name}"
    clean_path = os.path.join(dir_name, clean_name)
    cv2.imwrite(clean_path, clean)
    print(f"[Analyzer] Clean image saved: {clean_path}")

    return clean_path
