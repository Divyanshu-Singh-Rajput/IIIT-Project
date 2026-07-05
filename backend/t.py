import cv2
import numpy as np


import math

def detect_walls(image_path):
    img = cv2.imread(image_path)
    if img is None: return None, []
    
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 1. YOUR ORIGINAL MASK LOGIC
    _, mask = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
    kernel = np.ones((3,3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    # 2. VECTORIZATION (Hough Lines)
    # minLineLength=40 ignores noise; maxLineGap=20 connects small breaks
    lines = cv2.HoughLinesP(mask, 1, np.pi/180, 50, minLineLength=40, maxLineGap=20)
    
    wall_data = []
    if lines is not None:
        raw_lines = [l[0] for l in lines]
        merged_lines = []

        # 3. SNAP TO 90 DEGREES & MERGE
        # We sort by length so we process main walls first
        raw_lines.sort(key=lambda l: (l[2]-l[0])**2 + (l[3]-l[1])**2, reverse=True)

        TRACK_TOL = 15  # px: wall-thickness tolerance (same track?)
        GAP_TOL   = 8   # px: max gap between endpoints to still merge
        # NOTE: old code used GAP_TOL=20 which merged collinear but separate walls
        # in U/L/T shapes — reduced to 8px to prevent that.

        while len(raw_lines) > 0:
            l1 = raw_lines.pop(0)
            x1, y1, x2, y2 = l1

            # Force Orthogonality (Snap to 90 degrees) + normalise endpoints
            is_h = abs(y1 - y2) < abs(x1 - x2)
            if is_h:
                y2 = y1
                if x1 > x2: x1, x2 = x2, x1  # ensure x1 <= x2
            else:
                x2 = x1
                if y1 > y2: y1, y2 = y2, y1  # ensure y1 <= y2

            keep = True
            for i in range(len(merged_lines)):
                mx1, my1, mx2, my2 = merged_lines[i]
                m_is_h = abs(my1 - my2) < abs(mx1 - mx2)

                if is_h != m_is_h:
                    continue  # different orientation

                if is_h:
                    # Same direction: check they share the same Y track
                    if abs(y1 - my1) >= TRACK_TOL:
                        continue
                    lo_m, hi_m = min(mx1, mx2), max(mx1, mx2)
                    # Only merge if genuinely overlapping or touching within GAP_TOL
                    if x1 <= hi_m + GAP_TOL and x2 >= lo_m - GAP_TOL:
                        merged_lines[i] = [min(lo_m, x1), my1, max(hi_m, x2), my1]
                        keep = False; break
                else:
                    if abs(x1 - mx1) >= TRACK_TOL:
                        continue
                    lo_m, hi_m = min(my1, my2), max(my1, my2)
                    if y1 <= hi_m + GAP_TOL and y2 >= lo_m - GAP_TOL:
                        merged_lines[i] = [mx1, min(lo_m, y1), mx1, max(hi_m, y2)]
                        keep = False; break

            if keep: merged_lines.append([x1, y1, x2, y2])

        # 4. FORMAT INTO JSON LIST
        for idx, wall in enumerate(merged_lines):
            x1, y1, x2, y2 = wall
            wall_data.append({
                "id": f"wall_{idx + 1}",
                "start": {"x": int(x1), "y": int(y1)},
                "end": {"x": int(x2), "y": int(y2)},
                "length": int(math.sqrt((x1-x2)**2 + (y1-y2)**2)),
                "type": "horizontal" if abs(y1-y2) < abs(x1-x2) else "vertical"
            })

    # cv2.imshow("debug_walls", mask) 
    return mask, wall_data
def detect_gates(image_path):
    # 1. GET THE CLEAN MASK (Using your confirmed logic)
    img = cv2.imread(image_path)
    if img is None: return []
    h, w = img.shape[:2]
    
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                 cv2.THRESH_BINARY_INV, 11, 2)

    # Wall subtraction
    walls_mask,_ = detect_walls(image_path)
    walls_mask_fat = cv2.dilate(walls_mask, np.ones((3,3), np.uint8), iterations=1)
    mask = cv2.subtract(mask, walls_mask_fat)

    # Line removal to isolate arcs
    for k_size in [5, 15]: 
        h_k = cv2.getStructuringElement(cv2.MORPH_RECT, (k_size, 1))
        v_k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, k_size))
        lines = cv2.add(cv2.morphologyEx(mask, cv2.MORPH_OPEN, h_k),
                        cv2.morphologyEx(mask, cv2.MORPH_OPEN, v_k))
        mask = cv2.subtract(mask, cv2.dilate(lines, np.ones((3,3), np.uint8)))

    # Contour Analysis for Arcs
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    gates_data = []
    gate_idx = 1

    for c in cnts:
        area = cv2.contourArea(c)
        if area < 15: continue
        
        x, y, gw, gh = cv2.boundingRect(c)
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = float(area) / hull_area if hull_area > 0 else 0
        extent = float(area) / (gw * gh)

        # YOUR VALIDATION LOGIC
        if 0.2 < (float(gw)/gh) < 5.0 and solidity < 0.6 and extent < 0.5:
            
            # --- VECTORIZATION LOGIC ---
            # For an arc, the 'start' and 'end' should represent the door leaf.
            # We determine if the door is primarily horizontal or vertical.
            
            if gw > gh:
                # Horizontal Door Arc: Start at one side, end at the other
                start_pt = {"x": int(x), "y": int(y + gh)}
                end_pt = {"x": int(x + gw), "y": int(y + gh)}
            else:
                # Vertical Door Arc
                start_pt = {"x": int(x), "y": int(y)}
                end_pt = {"x": int(x), "y": int(y + gh)}

            gates_data.append({
                "id": f"gate_{gate_idx}",
                "start": start_pt,
                "end": end_pt,
                "width": int(max(gw, gh))
            })
            gate_idx += 1
    # cv2.imshow("debug_gates", mask)
    return gates_data


def detect_gates_robust(image_path):
    img = cv2.imread(image_path)
    if img is None: return None, []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 1. PRE-PROCESSING (Your existing logic)
    _, binary = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY_INV)
    walls,_ = detect_walls(image_path) 
    wall_core = cv2.erode(walls, np.ones((3,3), np.uint8), iterations=1)
    details = cv2.subtract(binary, wall_core)

    # 2. HEALING & LINE REMOVAL
    blurred = cv2.GaussianBlur(details, (9, 9), 0)
    _, healed = cv2.threshold(blurred, 50, 255, cv2.THRESH_BINARY)
    h_k = cv2.getStructuringElement(cv2.MORPH_RECT, (20, 1))
    v_k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 20))
    lines = cv2.add(cv2.morphologyEx(healed, cv2.MORPH_OPEN, h_k),
                    cv2.morphologyEx(healed, cv2.MORPH_OPEN, v_k))
    arcs_only = cv2.subtract(healed, lines)

    # 3. CONTOUR FILTERING
    cnts, _ = cv2.findContours(arcs_only, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    final_gate_mask = np.zeros_like(gray)
    valid_contours = []

    for c in cnts:
        area = cv2.contourArea(c)
        if area < 50: continue
        x, y, w, h = cv2.boundingRect(c)
        hull = cv2.convexHull(c)
        solidity = area / cv2.contourArea(hull) if cv2.contourArea(hull) > 0 else 0
        if 0.3 < (float(w)/h) < 3.0 and solidity < 0.6:
            cv2.drawContours(final_gate_mask, [c], -1, 255, -1)
            valid_contours.append(c)

    # --- 4. ANCHOR POINT CALCULATION (JSON GENERATION) ---
    gate_json = []
    
    # Skeletonize the specific gate mask to find the center spine
    skeleton = manual_skeletonize(final_gate_mask)
    
    # Find all potential endpoints in the skeleton
    endpoints = []
    ys, xs = np.where(skeleton > 0)
    for y, x in zip(ys, xs):
        if y == 0 or x == 0 or y >= skeleton.shape[0]-1 or x >= skeleton.shape[1]-1: continue
        if np.sum(skeleton[y-1:y+2, x-1:x+2]) == 510: # Center(255) + 1 neighbor(255)
            endpoints.append((int(x), int(y)))

    # Match endpoints to individual gates
    for i, c in enumerate(valid_contours):
        gate_ends = []
        for ep in endpoints:
            if cv2.pointPolygonTest(c, (float(ep[0]), float(ep[1])), False) >= 0:
                gate_ends.append(ep)
        
        if len(gate_ends) >= 2:
            p1, p2 = find_furthest_points(gate_ends)
            d1 = distance_to_nearest_wall(p1, walls)
            d2 = distance_to_nearest_wall(p2, walls)
            
            # Decide Hinge (Start) and Tip (End)
            hinge, tip = (p1, p2) if d1 < d2 else (p2, p1)
            
            gate_json.append({
                "id": f"gate_{i+1}",
                "start": {"x": int(hinge[0]), "y": int(hinge[1])},
                "end": {"x": int(tip[0]), "y": int(tip[1])},
                "width": int(math.sqrt((hinge[0]-tip[0])**2 + (hinge[1]-tip[1])**2))
            })

    # cv2.imshow("Final Gate Mask", final_gate_mask)
    # cv2.waitKey(0)
    return final_gate_mask, gate_json

# --- HELPER FUNCTIONS ---

def manual_skeletonize(img):
    skel = np.zeros(img.shape, np.uint8)
    _, img = cv2.threshold(img, 127, 255, cv2.THRESH_BINARY)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3,3))
    temp = img.copy()
    while True:
        eroded = cv2.erode(temp, element)
        opening = cv2.dilate(eroded, element)
        opening = cv2.subtract(temp, opening)
        skel = cv2.bitwise_or(skel, opening)
        temp = eroded.copy()
        if cv2.countNonZero(temp) == 0: break
    return skel

def find_furthest_points(pts):
    max_d = -1
    best_pair = (pts[0], pts[-1])
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = (pts[i][0]-pts[j][0])**2 + (pts[i][1]-pts[j][1])**2
            if d > max_d:
                max_d = d
                best_pair = (pts[i], pts[j])
    return best_pair

def distance_to_nearest_wall(point, wall_mask):
    dist_map = cv2.distanceTransform(cv2.bitwise_not(wall_mask), cv2.DIST_L2, 3)
    return dist_map[int(point[1]), int(point[0])]

def detect_windows_json(image_path, headless=False, return_mask=False):
    # 1. LOAD IMAGES
    img = cv2.imread(image_path)
    if img is None: return []
    # Create a copy for debugging
    debug_img = img.copy() 
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 2. MASK GENERATION (Your working logic)
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 12))
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (12, 1))
    v_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)
    
    thick_mask,_ = detect_walls(image_path) 
    thick_mask_fat = cv2.dilate(thick_mask, np.ones((2,2), np.uint8), iterations=1)
    
    win_pixels = cv2.subtract(cv2.bitwise_or(v_lines, h_lines), thick_mask_fat)
    win_pixels = cv2.morphologyEx(win_pixels, cv2.MORPH_OPEN, np.ones((2,2), np.uint8))

    # 3. OUTER WALL FILTER
    cnts, _ = cv2.findContours(thick_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        outer_ribbon = np.zeros_like(win_pixels)
        main_shell = max(cnts, key=cv2.contourArea)
        cv2.drawContours(outer_ribbon, [main_shell], -1, 255, thickness=40)
        win_pixels = cv2.bitwise_and(win_pixels, outer_ribbon)

    # 4. VECTORIZE
    # Note: minLineLength=10 is short to catch everything. maxLineGap=5 keeps them separate.
    lines = cv2.HoughLinesP(win_pixels, 1, np.pi/180, 15, minLineLength=10, maxLineGap=5)
    
    windows_json = []
    if lines is not None:
        for idx, line in enumerate(lines):
            x1, y1, x2, y2 = line[0]
            
            # Snap to 90 degrees
            is_h = abs(y1 - y2) < abs(x1 - x2)
            if is_h: y2 = y1
            else: x2 = x1
            
            # Store in JSON format
            windows_json.append({
                "id": f"window_{idx + 1}",
                "start": {"x": int(x1), "y": int(y1)},
                "end": {"x": int(x2), "y": int(y2)},
                "width": int(np.sqrt((x1-x2)**2 + (y1-y2)**2))
            })

    # --- 5. DEBUG DRAWING (only when NOT headless) ---
    if not headless:
        for win in windows_json:
            p1 = (win["start"]["x"], win["start"]["y"])
            p2 = (win["end"]["x"], win["end"]["y"])
            cv2.line(debug_img, p1, p2, (0, 0, 255), 3)
            cv2.circle(debug_img, p1, 3, (0, 255, 0), -1)
        # cv2.imshow("API_DATA_VISUAL_CHECK (RED=SENT)", debug_img)
        # cv2.waitKey(0)
        cv2.destroyAllWindows()
    
    if return_mask:
        return win_pixels, windows_json
    return windows_json

def classify_details(image_path='test/F3.png'):
    original = cv2.imread(image_path)
    if original is None:
        print(f"Error: Could not load image at {image_path}")
        return

    # 1. IMPORTANT: Use the functions that return MASKS (images) for visualization
    wall_mask,_ = detect_walls(image_path)
    gate_mask = detect_gates(image_path)
    # Ensure this is the function that returns a MASK, not the JSON list
    window_mask = detect_windows_json(image_path) 

    # 2. Check if any mask is None before proceeding
    if wall_mask is None or gate_mask is None or window_mask is None:
        print("Error: One of the detection functions returned None instead of an image.")
        return

    output = original.copy()
    
    # 3. Visualization loop
    detections = [
        (wall_mask, (255, 0, 0), "WALL"),      # Blue
        (gate_mask, (0, 255, 0), "GATE"),      # Green
        (window_mask, (0, 0, 255), "WINDOW")   # Red
    ]
    
    for mask, color, label in detections:
        # Check if 'mask' is a valid numpy array (image)
        if not isinstance(mask, np.ndarray):
            print(f"Error: {label} mask is a {type(mask)}, expected a numpy array.")
            continue

        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for c in cnts:
            if cv2.contourArea(c) < 5: continue
            cv2.drawContours(output, [c], -1, color, 2)
            x, y, w, h = cv2.boundingRect(c)
            cv2.putText(output, label, (x, y - 5), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)

    # cv2.imshow("Classified Floor Plan", output)
    # cv2.waitKey(0)
    cv2.destroyAllWindows()
# Run the classifier
# classify_details('test/F3.png')

detect_gates_robust('test/F3.png')
import cv2
import numpy as np
import scipy.optimize as optimize
import math

def snap_to_wall(point, wall_mask, search_radius=20):
    """Pulls a coordinate exactly onto the nearest white pixel (wall)."""
    x, y = int(point[0]), int(point[1])
    h, w = wall_mask.shape
    
    x_start, x_end = max(0, x - search_radius), min(w, x + search_radius)
    y_start, y_end = max(0, y - search_radius), min(h, y + search_radius)
    
    roi = wall_mask[y_start:y_end, x_start:x_end]
    wall_pts = np.column_stack(np.where(roi == 255))
    
    if len(wall_pts) > 0:
        # Calculate Euclidean distances
        distances = np.sqrt((wall_pts[:, 1] + x_start - x)**2 + (wall_pts[:, 0] + y_start - y)**2)
        closest_idx = np.argmin(distances)
        return int(wall_pts[closest_idx, 1] + x_start), int(wall_pts[closest_idx, 0] + y_start)
    return x, y

def fit_circle_to_points(points):
    """Mathematical circle fitting to find the theoretical hinge and radius."""
    if len(points) < 5: return None
    x, y = points[:, 0].astype(float), points[:, 1].astype(float)
    def calc_R(xc, yc): return np.sqrt((x - xc)**2 + (y - yc)**2)
    def f_2(c): 
        Ri = calc_R(*c)
        return Ri - Ri.mean()
    try:
        center_guess = np.mean(x), np.mean(y)
        center_2, _ = optimize.leastsq(f_2, center_guess, maxfev=500)
        xc, yc = center_2
        R = calc_R(xc, yc).mean()
        if R > 400 or R < 10: return None
        return xc, yc, R
    except: return None

def find_best_strike(hinge, radius, wall_mask):
    """
    Probes in 4 directions (Left, Right, Up, Down) to find the wall 
    on the other side of the door opening.
    """
    hx, hy = hinge
    h, w = wall_mask.shape
    # Search up to 2x the radius to find the strike wall
    max_search = int(radius * 2.0)
    
    candidates = []
    # Directions: (dx, dy)
    directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    
    for dx, dy in directions:
        found_gap = False
        for i in range(5, max_search):
            cx, cy = hx + (i * dx), hy + (i * dy)
            if not (0 <= cx < w and 0 <= cy < h): break
            
            # Step 1: Confirm we are in the 'gap' (empty space)
            if wall_mask[cy, cx] == 0:
                found_gap = True
            
            # Step 2: Find the first wall pixel AFTER the gap
            if found_gap and wall_mask[cy, cx] == 255:
                strike_point = snap_to_wall((cx, cy), wall_mask, 10)
                dist = math.sqrt((hx - strike_point[0])**2 + (hy - strike_point[1])**2)
                # A strike point should be roughly one 'radius' away
                score = abs(dist - radius)
                candidates.append((strike_point, score))
                break
    
    if not candidates: return None
    # Return the candidate whose distance matches the arc radius most closely
    return min(candidates, key=lambda c: c[1])[0]

def reconstruct_gates_final(gate_mask, wall_mask):
    """
    Main Process: 
    1. Fits circles to arcs 
    2. Snaps hinges to walls 
    3. Probes for strike points to close the door gap.
    """
    # Clean up the gate mask segments
    gate_mask = cv2.morphologyEx(gate_mask, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
    cnts, _ = cv2.findContours(gate_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    # Visual debug overlay on wall mask
    debug_viz = cv2.cvtColor(wall_mask, cv2.COLOR_GRAY2BGR)
    gate_json = []

    for i, c in enumerate(cnts):
        if cv2.contourArea(c) < 15: continue
        
        # Extract pixel coordinates of the arc
        mask_temp = np.zeros_like(gate_mask)
        cv2.drawContours(mask_temp, [c], -1, 255, -1)
        pixel_points = np.column_stack(np.where(mask_temp == 255))[:, ::-1]

        fit = fit_circle_to_points(pixel_points)
        x, y, w, h = cv2.boundingRect(c)
        
        if fit:
            cx, cy, R = fit
            # Hinge is the corner of the bounding box closest to the circle center
            corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
            raw_h = min(corners, key=lambda p: (p[0]-cx)**2 + (p[1]-cy)**2)
        else:
            R = max(w, h); raw_h = (x, y)

        # 1. Snap Hinge to Wall
        hx, hy = snap_to_wall(raw_h, wall_mask)

        # 2. Find Strike Point (The other edge of the gap)
        strike = find_best_strike((hx, hy), R, wall_mask)
        
        if strike:
            sx, sy = strike
        else:
            # Fallback: estimate end point based on arc orientation
            sx = hx + (int(R) if raw_h[0] < x + w/2 else -int(R))
            sy = hy + (int(R) if raw_h[1] < y + h/2 else -int(R))

        # 3. Save Data
        gate_info = {
            "id": f"gate_{i+1}",
            "hinge": {"x": hx, "y": hy},
            "strike": {"x": sx, "y": sy},
            "width": int(math.sqrt((hx-sx)**2 + (hy-sy)**2))
        }
        gate_json.append(gate_info)

        # --- Visual Debugging ---
        # Draw the detected arc in Green
        cv2.drawContours(debug_viz, [c], -1, (0, 255, 0), 1)
        # Draw the 'Closed Door' line in Yellow
        cv2.line(debug_viz, (hx, hy), (sx, sy), (0, 255, 255), 2)
        # Mark both Anchor Points in RED
        cv2.circle(debug_viz, (hx, hy), 5, (0, 0, 255), -1)
        cv2.circle(debug_viz, (sx, sy), 5, (0, 0, 255), -1)
        # Label
        cv2.putText(debug_viz, f"Gate {i+1}", (hx, hy-10), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)

    return debug_viz, gate_json

# --- Execution ---
# Note: Ensure detect_gates_robust and detect_walls return (mask, data)


def get_final_gate_data(image_path):
    """Returns (debug_img, gate_json) — caller should unpack as: _, gates = get_final_gate_data(...)"""
    gate_mask, _ = detect_gates_robust(image_path)
    wall_mask, _ = detect_walls(image_path)

    debug_img, json_data = reconstruct_gates_final(gate_mask, wall_mask)
    return debug_img, json_data



