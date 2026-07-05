import cv2
import numpy as np
import json

def get_wall_json(image_path):
    img = cv2.imread(image_path)
    if img is None:
        return {"error": "File not found"}
    
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 1. THRESHOLD & CLEAN
    _, mask = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY_INV)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean_mask = np.zeros_like(mask)
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] > 100: 
            clean_mask[labels == i] = 255

    # 2. SKELETONIZE (Find the center line)
    skeleton = cv2.ximgproc.thinning(clean_mask) if hasattr(cv2, 'ximgproc') else clean_mask

    # 3. DETECT LINES
    lines = cv2.HoughLinesP(skeleton, 1, np.pi/180, threshold=20, 
                            minLineLength=10, maxLineGap=15)
    
    if lines is None:
        return {"project_name": "Empty Plan", "walls": []}

    raw_lines = [l[0] for l in lines]
    master_walls = []

    # 4. SNAP & MERGE (Remove double lines and segments)
    # Only merge segments that are on the SAME axis-track (within TRACK_TOL pixels)
    # AND genuinely overlapping or very close (within GAP_TOL pixels).
    # Using a tight GAP_TOL prevents merging separate collinear segments that
    # belong to different sides of U/L/T shapes.
    TRACK_TOL = 5   # px: how close two parallel lines must be on their shared axis
    GAP_TOL   = 8   # px: maximum gap between segment ends to still merge them

    while len(raw_lines) > 0:
        l1 = raw_lines.pop(0)
        x1, y1, x2, y2 = l1
        is_h = abs(y1 - y2) < abs(x1 - x2)

        # Snap to 90 degrees
        if is_h:
            y2 = y1  # force same Y
            # Normalise so x1 <= x2
            if x1 > x2: x1, x2 = x2, x1
        else:
            x2 = x1  # force same X
            # Normalise so y1 <= y2
            if y1 > y2: y1, y2 = y2, y1

        merged = False
        for i in range(len(master_walls)):
            mx1, my1, mx2, my2 = master_walls[i]
            m_is_h = abs(my1 - my2) < abs(mx1 - mx2)

            if is_h != m_is_h:
                continue  # different orientation

            if is_h:
                # Both horizontal: must share nearly the same Y
                if abs(y1 - my1) > TRACK_TOL:
                    continue
                # Normalise master coords
                lo_m, hi_m = min(mx1, mx2), max(mx1, mx2)
                lo_n, hi_n = x1, x2
                # Only merge if the segments overlap or touch within GAP_TOL
                if lo_n <= hi_m + GAP_TOL and hi_n >= lo_m - GAP_TOL:
                    master_walls[i] = [min(lo_m, lo_n), my1, max(hi_m, hi_n), my1]
                    merged = True
                    break
            else:
                # Both vertical: must share nearly the same X
                if abs(x1 - mx1) > TRACK_TOL:
                    continue
                lo_m, hi_m = min(my1, my2), max(my1, my2)
                lo_n, hi_n = y1, y2
                if lo_n <= hi_m + GAP_TOL and hi_n >= lo_m - GAP_TOL:
                    master_walls[i] = [mx1, min(lo_m, lo_n), mx1, max(hi_m, hi_n)]
                    merged = True
                    break

        if not merged:
            master_walls.append([x1, y1, x2, y2])

    # ── 5. CORNER SNAPPING ────────────────────────────────────────────────────
    # After merge, endpoints of adjacent walls are often 5-15 px apart, creating
    # visible gaps in the 3D model. This pass snaps nearby endpoints to the same
    # coordinate so every corner is perfectly shared.

    CORNER_SNAP = 10  # px – if two endpoints are closer than this, merge them

    def _endpoints(wall):
        x1, y1, x2, y2 = wall
        return [(x1, y1), (x2, y2)]

    def _set_endpoint(wall, idx, pt):
        """Return a new wall list with endpoint idx (0 or 1) moved to pt."""
        x1, y1, x2, y2 = wall
        if idx == 0:
            return [pt[0], pt[1], x2, y2]
        else:
            return [x1, y1, pt[0], pt[1]]

    # Iteratively snap all close endpoint pairs until stable
    changed = True
    while changed:
        changed = False
        eps = []
        for wi, wall in enumerate(master_walls):
            for ei, (ex, ey) in enumerate(_endpoints(wall)):
                eps.append((wi, ei, ex, ey))

        for i in range(len(eps)):
            wi, ei, xi, yi = eps[i]
            for j in range(i + 1, len(eps)):
                wj, ej, xj, yj = eps[j]
                if wi == wj:
                    continue  # same wall, skip
                d = ((xi - xj) ** 2 + (yi - yj) ** 2) ** 0.5
                if d < CORNER_SNAP and d > 0:
                    # Snap both to their midpoint (average)
                    mx = int(round((xi + xj) / 2))
                    my = int(round((yi + yj) / 2))
                    master_walls[wi] = _set_endpoint(master_walls[wi], ei, (mx, my))
                    master_walls[wj] = _set_endpoint(master_walls[wj], ej, (mx, my))
                    changed = True  # restart to propagate transitively
                    break
            if changed:
                break

    # ── 6. OUTER BOUNDARY CLOSURE ─────────────────────────────────────────────
    # Extract the main outer contour of the wall mask, simplify it into a
    # polygon and ensure every edge of that polygon appears in our wall list.
    # This guarantees the outer perimeter is always a closed, connected loop
    # regardless of what HoughLinesP found.

    # Dilate clean_mask slightly to close tiny contour gaps
    kernel = np.ones((5, 5), np.uint8)
    closed_mask = cv2.morphologyEx(clean_mask, cv2.MORPH_CLOSE, kernel)

    outer_cnts, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if outer_cnts:
        main_cnt = max(outer_cnts, key=cv2.contourArea)
        # Approximate to a polygon — epsilon tuned for architectural drawings
        peri    = cv2.arcLength(main_cnt, True)
        # Use a tight epsilon so concave corners (U/L/T shapes) are preserved.
        # 0.01 is too loose and collapses interior notches into straight edges.
        epsilon = 0.005 * peri
        approx  = cv2.approxPolyDP(main_cnt, epsilon, True)
        pts     = [tuple(p[0]) for p in approx]

        if len(pts) >= 3:
            # Build the perimeter edge list (closed loop)
            outer_edges = []
            for k in range(len(pts)):
                p1 = pts[k]
                p2 = pts[(k + 1) % len(pts)]
                # Snap each edge to 90° (floor plans are rectilinear)
                dx_e = abs(p2[0] - p1[0])
                dy_e = abs(p2[1] - p1[1])
                if dx_e >= dy_e:
                    # horizontal: lock Y to average
                    mid_y = int(round((p1[1] + p2[1]) / 2))
                    edge  = [min(p1[0], p2[0]), mid_y, max(p1[0], p2[0]), mid_y]
                else:
                    # vertical: lock X to average
                    mid_x = int(round((p1[0] + p2[0]) / 2))
                    edge  = [mid_x, min(p1[1], p2[1]), mid_x, max(p1[1], p2[1])]

                edge_len = int(((edge[2]-edge[0])**2 + (edge[3]-edge[1])**2)**0.5)
                if edge_len < 10:
                    continue  # skip degenerate micro-edges
                outer_edges.append(edge)

            # ── Snap outer edges against existing master_walls ──────────────
            # For each outer edge, check whether an existing wall already covers
            # this segment (within tolerance). If not, add it so the perimeter
            # is always closed.
            OUTER_SNAP = 6  # px tolerance for "same wall"

            def _covers(existing, edge):
                """True if 'existing' substantially covers 'edge' (same axis-line, overlapping).
                
                A wall only counts as 'covered' if it shares the same axis track AND
                the existing segment overlaps at least 50% of the outer edge's length.
                This prevents a long wall from suppressing a separate short parallel
                segment that belongs to a different side of a U/L shape.
                """
                x1e, y1e, x2e, y2e = existing
                x1n, y1n, x2n, y2n = edge
                is_h_e = abs(y1e - y2e) < abs(x1e - x2e)
                is_h_n = abs(y1n - y2n) < abs(x1n - x2n)
                if is_h_e != is_h_n:
                    return False
                if is_h_e:
                    if abs(y1e - y1n) > OUTER_SNAP:
                        return False
                    # Overlap in X — require substantial coverage (80%)
                    lo_e, hi_e = min(x1e, x2e), max(x1e, x2e)
                    lo_n, hi_n = min(x1n, x2n), max(x1n, x2n)
                    overlap = max(0, min(hi_e, hi_n) - max(lo_e, lo_n))
                    edge_len = hi_n - lo_n
                    return overlap >= edge_len * 0.8 if edge_len > 0 else True
                else:
                    if abs(x1e - x1n) > OUTER_SNAP:
                        return False
                    lo_e, hi_e = min(y1e, y2e), max(y1e, y2e)
                    lo_n, hi_n = min(y1n, y2n), max(y1n, y2n)
                    overlap = max(0, min(hi_e, hi_n) - max(lo_e, lo_n))
                    edge_len = hi_n - lo_n
                    return overlap >= edge_len * 0.8 if edge_len > 0 else True

            for edge in outer_edges:
                covered = any(_covers(existing, edge) for existing in master_walls)
                if not covered:
                    master_walls.append(edge)

            # ── Final corner-snap pass after outer-edge injection ─────────────
            changed = True
            while changed:
                changed = False
                eps = []
                for wi, wall in enumerate(master_walls):
                    for ei, (ex, ey) in enumerate(_endpoints(wall)):
                        eps.append((wi, ei, ex, ey))
                for i in range(len(eps)):
                    wi, ei, xi, yi = eps[i]
                    for j in range(i + 1, len(eps)):
                        wj, ej, xj, yj = eps[j]
                        if wi == wj:
                            continue
                        d = ((xi - xj) ** 2 + (yi - yj) ** 2) ** 0.5
                        if d < CORNER_SNAP and d > 0:
                            mx = int(round((xi + xj) / 2))
                            my = int(round((yi + yj) / 2))
                            master_walls[wi] = _set_endpoint(master_walls[wi], ei, (mx, my))
                            master_walls[wj] = _set_endpoint(master_walls[wj], ej, (mx, my))
                            changed = True
                            break
                    if changed:
                        break

    # 7. CONVERT TO DICTIONARY FORMAT
    wall_data = []
    for idx, wall in enumerate(master_walls):
        x1, y1, x2, y2 = wall
        # Skip degenerate (zero-length) walls that snapping may have created
        length = int(((x1-x2)**2 + (y1-y2)**2)**0.5)
        if length < 5:
            continue
        wall_type = "horizontal" if abs(y1 - y2) < abs(x1 - x2) else "vertical"
        
        wall_data.append({
            "id": f"wall_{idx + 1}",
            "type": wall_type,
            "start": {"x": int(x1), "y": int(y1)},
            "end": {"x": int(x2), "y": int(y2)},
            "length": length
        })

    # FINAL STRUCTURE
    floorplan_json = {
        "project_info": {
            "name": "Floor Plan Extraction",
            "image_size": {"width": w, "height": h}
        },
        "walls": wall_data
    }

    return floorplan_json
