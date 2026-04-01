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
    _, mask = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
    kernel = np.ones((3,3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean_mask = np.zeros_like(mask)
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] > 100: 
            clean_mask[labels == i] = 255

    # 2. SKELETONIZE (Find the center line)
    skeleton = cv2.ximgproc.thinning(clean_mask) if hasattr(cv2, 'ximgproc') else clean_mask

    # 3. DETECT LINES
    lines = cv2.HoughLinesP(skeleton, 1, np.pi/180, threshold=20, 
                            minLineLength=10, maxLineGap=40)
    
    if lines is None:
        return {"project_name": "Empty Plan", "walls": []}

    raw_lines = [l[0] for l in lines]
    master_walls = []

    # 4. SNAP & MERGE (Remove double lines and segments)
    # Only merge segments that are on the SAME axis-track (within TRACK_TOL pixels)
    # AND genuinely overlapping or very close (within GAP_TOL pixels).
    # TRACK_TOL=5 handles the U/L/T fusing concern by keeping parallel offsets separate.
    # 4. SNAP & MERGE (Robust iterative pairwise merge)
    TRACK_TOL = 5   # px: how close two parallel lines must be on their shared axis
    GAP_TOL   = 80  # px: maximum gap between segment ends to still merge them

    def _should_merge(w1, w2):
        x1_a, y1_a, x2_a, y2_a = w1
        x1_b, y1_b, x2_b, y2_b = w2
        is_h_a = abs(y1_a - y2_a) < abs(x1_a - x2_a)
        is_h_b = abs(y1_b - y2_b) < abs(x1_b - x2_b)
        if is_h_a != is_h_b: return False, None
        
        if is_h_a:
            if abs(y1_a - y1_b) > TRACK_TOL: return False, None
            lo_a, hi_a = min(x1_a, x2_a), max(x1_a, x2_a)
            lo_b, hi_b = min(x1_b, x2_b), max(x1_b, x2_b)
            if lo_b <= hi_a + GAP_TOL and hi_b >= lo_a - GAP_TOL:
                return True, [min(lo_a, lo_b), y1_a, max(hi_a, hi_b), y1_a]
        else:
            if abs(x1_a - x1_b) > TRACK_TOL: return False, None
            lo_a, hi_a = min(y1_a, y2_a), max(y1_a, y2_a)
            lo_b, hi_b = min(y1_b, y2_b), max(y1_b, y2_b)
            if lo_b <= hi_a + GAP_TOL and hi_b >= lo_a - GAP_TOL:
                return True, [x1_a, min(lo_a, lo_b), x1_a, max(hi_a, hi_b)]
        return False, None

    master_walls = []
    # Initial insertion
    for line in raw_lines:
        master_walls.append(list(line))

    # Iterative pairwise merge
    changed = True
    while changed:
        changed = False
        new_master = []
        skip_indices = set()
        for i in range(len(master_walls)):
            if i in skip_indices: continue
            current_wall = master_walls[i]
            for j in range(i + 1, len(master_walls)):
                if j in skip_indices: continue
                can_merge, merged_wall = _should_merge(current_wall, master_walls[j])
                if can_merge:
                    current_wall = merged_wall
                    skip_indices.add(j)
                    changed = True
            new_master.append(current_wall)
        master_walls = new_master

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
