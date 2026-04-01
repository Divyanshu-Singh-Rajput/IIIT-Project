import cv2
import numpy as np
import os
import json
from shapely.geometry import LineString, Polygon, Point


# ═══════════════════════════════════════════════════════════════════
#  TUNABLE CONSTANTS  — adjust these if your image scale changes
# ═══════════════════════════════════════════════════════════════════

# HoughCircles params
HC_DP          = 1      # inverse resolution ratio (1 = full res)
HC_MIN_DIST    = 30     # minimum distance between detected circle centres
HC_PARAM1      = 50     # Canny high threshold inside HoughCircles
HC_PARAM2      = 20     # accumulator threshold — LOWER = more detections
                        # raise to 25-30 if you get too many false circles
HC_MIN_RADIUS  = 30     # smallest door arc radius in pixels
HC_MAX_RADIUS  = 80     # largest door arc radius in pixels
                        # (in the sample image doors are r=41-74 px)

# Gate matching — how strictly a detected circle must align with a wall line
PIVOT_SNAP        = 25  # px: arc centre must be this close to a wall endpoint
RADIUS_TOLERANCE  = 0.40  # arc radius vs wall-line length may differ by ±40 %

# Window detection
WIN_SNAP = 14           # px: window centroid must be this close to a wall line


# ═══════════════════════════════════════════════════════════════════
#  1. WINDOW DETECTION
#     Windows = thin elongated rectangles, perfectly convex (no arc).
# ═══════════════════════════════════════════════════════════════════

def _detect_windows(gray: np.ndarray) -> list[dict]:
    """Returns list of {x, y, w, h, cx, cy}."""
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    windows = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if not (100 < area < 5000):
            continue

        epsilon = 0.02 * cv2.arcLength(cnt, True)
        approx  = cv2.approxPolyDP(cnt, epsilon, True)
        if len(approx) != 4:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        aspect = float(w) / h if h > 0 else 0

        # Windows are elongated (thin in one axis)
        if not (aspect > 1.5 or aspect < 0.6):
            continue

        # Perfectly convex → not a door arc contour
        if not cv2.isContourConvex(approx):
            continue

        windows.append({
            "x": x, "y": y, "w": w, "h": h,
            "cx": x + w / 2, "cy": y + h / 2,
        })

    return windows


# ═══════════════════════════════════════════════════════════════════
#  2. GATE / DOOR DETECTION  — HoughCircles-based
#
#  An architectural door = straight line (door panel, length R)
#  + quarter-circle arc of radius R from one endpoint.
#
#  HoughCircles detects the arc directly; we then match each detected
#  circle to the nearest wall-line endpoint whose length ≈ the radius.
# ═══════════════════════════════════════════════════════════════════

def _detect_gates(gray: np.ndarray,
                  debug_img: np.ndarray | None = None) -> list[dict]:
    """
    Returns list of {cx, cy, width}.
      cx, cy  = arc centre = door hinge point in image pixels
      width   = arc radius = door panel length in image pixels
    """
    # Blur slightly so the thin arc stroke feeds cleanly into Hough
    blurred = cv2.GaussianBlur(gray, (5, 5), 1)

    raw = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp        = HC_DP,
        minDist   = HC_MIN_DIST,
        param1    = HC_PARAM1,
        param2    = HC_PARAM2,
        minRadius = HC_MIN_RADIUS,
        maxRadius = HC_MAX_RADIUS,
    )

    gates = []
    if raw is None:
        return gates

    for cx, cy, r in np.round(raw[0]).astype(int):
        gates.append({
            "cx":    float(cx),
            "cy":    float(cy),
            "width": float(r),
        })

        if debug_img is not None:
            cv2.circle(debug_img, (cx, cy), r,    (0, 140, 255), 2)
            cv2.circle(debug_img, (cx, cy), 4,    (0,  60, 255), -1)
            cv2.putText(debug_img, f"r={r}",
                        (cx + 6, cy - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 100, 255), 1)

    return gates


# ═══════════════════════════════════════════════════════════════════
#  3. CLASSIFY OPENINGS PER WALL SEGMENT
# ═══════════════════════════════════════════════════════════════════

def _classify_openings(line:    LineString,
                       windows: list[dict],
                       gates:   list[dict]) -> list[dict]:
    openings = []

    # ── Window check (centroid close to the wall line) ────────────────────────
    for win in windows:
        pt = Point(win["cx"], win["cy"])
        if line.distance(pt) <= WIN_SNAP:
            proj = line.project(pt)
            openings.append({
                "type":   "window",
                "offset": round(proj, 2),
                "width":  round(max(win["w"], win["h"]), 2),
            })
            break   # at most one window per segment

    if openings:
        return openings  # windows take priority

    # ── Gate check ────────────────────────────────────────────────────────────
    # Rule: the arc's centre (hinge) must lie very close to ONE ENDPOINT of the
    # wall segment, AND the arc radius must roughly equal the segment length.
    #
    # Why endpoints only?  The hinge of a door is always at a wall corner —
    # never floating in the middle of a wall.
    p0       = Point(line.coords[0])
    p1       = Point(line.coords[1])
    line_len = line.length

    for gate in gates:
        gpt     = Point(gate["cx"], gate["cy"])
        near_p0 = gpt.distance(p0) <= PIVOT_SNAP
        near_p1 = gpt.distance(p1) <= PIVOT_SNAP

        if not (near_p0 or near_p1):
            continue

        radius_ok = (abs(gate["width"] - line_len) / max(line_len, 1)
                     <= RADIUS_TOLERANCE)
        if not radius_ok:
            continue

        openings.append({
            "type":   "gate",
            "offset": 0,
            "width":  round(gate["width"], 2),
        })
        break   # at most one gate per segment

    return openings


# ═══════════════════════════════════════════════════════════════════
#  4. MAIN
# ═══════════════════════════════════════════════════════════════════

def get_Cordinates(DEBUG: bool = False) -> dict:
    file_path = os.path.join(os.getcwd(), 'test', 'F2.png')
    img = cv2.imread(file_path)
    if img is None:
        return {"rooms": []}

    # ── Pre-processing & text removal ─────────────────────────────────────────
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    nlabels, labels, stats, _ = cv2.connectedComponentsWithStats(thresh, connectivity=8)
    text_mask = np.zeros_like(thresh)
    for i in range(1, nlabels):
        if stats[i,2] < 60 and stats[i,3] < 60 and stats[i,4] < 800:
            text_mask[labels == i] = 255

    clean_img  = cv2.inpaint(img, text_mask, 3, cv2.INPAINT_TELEA)
    clean_gray = cv2.cvtColor(clean_img, cv2.COLOR_BGR2GRAY)

    _, clean_thresh = cv2.threshold(clean_gray, 200, 255, cv2.THRESH_BINARY_INV)
    kernel     = np.ones((4, 4), np.uint8)
    walls_mask = cv2.morphologyEx(clean_thresh, cv2.MORPH_CLOSE, kernel)

    # ── Feature detection ─────────────────────────────────────────────────────
    windows        = _detect_windows(clean_gray)
    debug_line_img = img.copy()
    gates          = _detect_gates(clean_gray,
                                   debug_img=debug_line_img if DEBUG else None)

    if DEBUG:
        print(f"[DEBUG] Windows detected : {len(windows)}")
        print(f"[DEBUG] Gate arcs detected: {len(gates)}")
        for g in gates:
            print(f"         arc  cx={g['cx']:.0f} cy={g['cy']:.0f} r={g['width']:.0f}")

    # ── Room contours + Hough lines ───────────────────────────────────────────
    contours, _ = cv2.findContours(walls_mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    lines = cv2.HoughLinesP(
        walls_mask, 1, np.pi / 180,
        threshold=30, minLineLength=40, maxLineGap=15,
    )

    rooms_data = []

    if lines is not None:
        all_wall_lines = [
            LineString([(l[0][0], l[0][1]), (l[0][2], l[0][3])])
            for l in lines
        ]

        for i, cnt in enumerate(contours):
            if cv2.contourArea(cnt) < 2000:
                continue

            x, y, w, h = cv2.boundingRect(cnt)
            room_poly   = Polygon(cnt.reshape(-1, 2))

            room_obj = {
                "name":   f"Room {i + 1}",
                "center": {"x": float(x + w / 2), "y": float(y + h / 2)},
                "walls":  [],
            }

            for line in all_wall_lines:
                if not room_poly.buffer(5).intersects(line):
                    continue

                x1, y1 = line.coords[0]
                x2, y2 = line.coords[1]

                openings = _classify_openings(line, windows, gates)

                # Debug colours: blue=window, orange=gate, green=plain wall
                if any(o["type"] == "window" for o in openings):
                    color = (255, 120, 0)
                elif any(o["type"] == "gate" for o in openings):
                    color = (0, 165, 255)
                else:
                    color = (0, 210, 0)

                cv2.line(debug_line_img,
                         (int(x1), int(y1)), (int(x2), int(y2)), color, 2)

                room_obj["walls"].append({
                    "id":       f"wall_{len(room_obj['walls'])}",
                    "start":    {"x": float(x1), "y": float(y1)},
                    "end":      {"x": float(x2), "y": float(y2)},
                    "openings": openings,
                })

            rooms_data.append(room_obj)

    # ── Debug display ─────────────────────────────────────────────────────────
    if DEBUG:
        # Mark windows cyan
        for win in windows:
            cv2.rectangle(debug_line_img,
                          (win["x"], win["y"]),
                          (win["x"] + win["w"], win["y"] + win["h"]),
                          (255, 255, 0), 2)
            cv2.putText(debug_line_img, "WIN",
                        (win["x"], win["y"] - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 0), 1)

        text_vis  = cv2.cvtColor(text_mask,  cv2.COLOR_GRAY2BGR)
        walls_vis = cv2.cvtColor(walls_mask, cv2.COLOR_GRAY2BGR)

        # Show gate circles on the walls mask panel too
        for g in gates:
            cv2.circle(walls_vis,
                       (int(g["cx"]), int(g["cy"])), int(g["width"]),
                       (0, 140, 255), 2)

        top_row    = np.hstack((img,       text_vis))
        bottom_row = np.hstack((walls_vis, debug_line_img))
        combined   = cv2.resize(np.vstack((top_row, bottom_row)),
                                (0, 0), fx=0.6, fy=0.6)

        cv2.imshow(
            'TL:Original | TR:TextMask | BL:WallsMask+GateCircles | BR:Detected',
            combined,
        )
        cv2.waitKey(0)
        cv2.destroyAllWindows()

    return {"rooms": rooms_data}


# ─────────────────────────────────────────────
if __name__ == "__main__":
    result = get_Cordinates(DEBUG=True)
    print(json.dumps(result, indent=2))