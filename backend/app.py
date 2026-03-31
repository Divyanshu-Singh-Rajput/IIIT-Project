import os
import glob
from flask import Flask, jsonify, request
from flask_cors import CORS

# Load .env file if present (so GEMINI_API_KEY can be set there)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed — use real env vars instead

from turtle_test import get_wall_json
from t import get_final_gate_data, detect_windows_json


app = Flask(__name__)
CORS(app)

TEST_DIR = os.path.join(os.path.dirname(__file__), 'test')


def get_image_path(image_name):
    """Resolve and validate an image path inside the test directory."""
    if not image_name:
        pngs = sorted(glob.glob(os.path.join(TEST_DIR, '*.png')))
        if not pngs:
            raise FileNotFoundError("No PNG files found in test/ directory")
        return pngs[0]
    safe_name = os.path.basename(image_name)
    path = os.path.join(TEST_DIR, safe_name)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Image '{safe_name}' not found in test/ directory")
    return path


# ── Existing endpoints ────────────────────────────────────────────────────────

@app.route('/api/images')
def list_images():
    """Return the list of available floor plan PNGs."""
    try:
        pngs = sorted(glob.glob(os.path.join(TEST_DIR, '*.png')))
        names = [os.path.basename(p) for p in pngs]
        return jsonify({"status": "success", "images": names})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/upload', methods=['POST'])
def upload_image():
    """Upload custom floor plan, convert to png, save with random UUID."""
    if 'image' not in request.files:
        return jsonify({"status": "error", "message": "No image part in the request"}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No selected file"}), 400

    try:
        import cv2
        import numpy as np
        import uuid
        
        # Read the file to numpy array
        file_bytes = np.frombuffer(file.read(), np.uint8)
        img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image file format"}), 400
            
        new_filename = f"upload_{uuid.uuid4().hex[:8]}.png"
        save_path = os.path.join(TEST_DIR, new_filename)
        
        # Save explicitly as .png to normalize the format
        cv2.imwrite(save_path, img)
        return jsonify({"status": "success", "image": new_filename}), 200
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/data')
def get_data():
    """
    Analyse a floor plan PNG and return walls, windows, and gates.
    Optional query parameter: ?image=F3.png  (defaults to first PNG found)
    """
    try:
        image_name = request.args.get('image', '')
        image_path = get_image_path(image_name)

        walls_data = get_wall_json(image_path)
        windows    = detect_windows_json(image_path, headless=True)
        _, gates   = get_final_gate_data(image_path)   # returns hinge/strike format

        return jsonify({
            "status":  "success",
            "image":   os.path.basename(image_path),
            "data":    walls_data,
            "windows": windows,
            "gates":   gates,
        })
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/masks')
def get_masks():
    """
    Returns base64 encoded debug masks for 2D visualization.
    """
    import cv2
    import base64
    from t import detect_walls, detect_gates_robust
    
    def img_to_b64(img):
        if img is None: return ""
        # Handle binary masks by converting back to BGR for standard PNG saving if needed, 
        # but imencode usually handles 1-channel uint8 just fine.
        _, buffer = cv2.imencode('.png', img)
        return "data:image/png;base64," + base64.b64encode(buffer).decode('utf-8')

    try:
        image_name = request.args.get('image', '')
        image_path = get_image_path(image_name)

        # Original Image
        original = cv2.imread(image_path)
        
        # Walls
        wall_mask, _ = detect_walls(image_path)
        
        # Gates
        gate_mask, _ = detect_gates_robust(image_path)
        
        # Windows
        win_mask, _ = detect_windows_json(image_path, headless=True, return_mask=True)

        return jsonify({
            "status": "success",
            "image": os.path.basename(image_path),
            "masks": {
                "original": img_to_b64(original),
                "walls": img_to_b64(wall_mask),
                "windows": img_to_b64(win_mask),
                "gates": img_to_b64(gate_mask)
            }
        })
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


# ── Material scoring tables ───────────────────────────────────────────────────

MATERIAL_DB = {
    "load_bearing_wall": [
        {
            "material": "Reinforced Concrete (M25)",
            "score": 0.912,
            "unit_cost_inr": 6800,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "Very High",
            "notes": "Industry-standard for load-bearing walls. Excellent seismic performance.",
        },
        {
            "material": "Reinforced Concrete (M30)",
            "score": 0.874,
            "unit_cost_inr": 7500,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "Very High",
            "notes": "Higher grade for aggressive environments or slender sections.",
        },
        {
            "material": "Brick Masonry",
            "score": 0.641,
            "unit_cost_inr": 3200,
            "cost_label": "Low-Medium",
            "strength_label": "Medium",
            "durability_label": "High",
            "notes": "Traditional option; needs RCC band reinforcement in seismic zones.",
        },
    ],
    "partition_wall": [
        {
            "material": "AAC Block Wall",
            "score": 0.883,
            "unit_cost_inr": 2900,
            "cost_label": "Low-Medium",
            "strength_label": "Low",
            "durability_label": "High",
            "notes": "Lightweight, thermally insulating — ideal for interior partitions.",
        },
        {
            "material": "Fly Ash Brick",
            "score": 0.754,
            "unit_cost_inr": 2100,
            "cost_label": "Low",
            "strength_label": "Medium",
            "durability_label": "Medium",
            "notes": "Eco-friendly, dimensionally consistent; good for low-rise partitions.",
        },
        {
            "material": "Hollow Block (Concrete)",
            "score": 0.692,
            "unit_cost_inr": 2400,
            "cost_label": "Low",
            "strength_label": "Medium",
            "durability_label": "High",
            "notes": "Cores can be grouted for extra strength; good acoustic separation.",
        },
    ],
    "slab": [
        {
            "material": "Reinforced Concrete (M25)",
            "score": 0.935,
            "unit_cost_inr": 7200,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "Very High",
            "notes": "Standard flat slab specification for residential and commercial floors.",
        },
        {
            "material": "Precast Concrete Panel",
            "score": 0.861,
            "unit_cost_inr": 6100,
            "cost_label": "Medium-High",
            "strength_label": "High",
            "durability_label": "Very High",
            "notes": "Factory-made hollow-core panels — faster installation, less wet work.",
        },
        {
            "material": "Steel Frame (MS)",
            "score": 0.788,
            "unit_cost_inr": 9500,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "High",
            "notes": "Composite deck option for long spans; requires fireproofing.",
        },
    ],
    "column": [
        {
            "material": "Reinforced Concrete (M30)",
            "score": 0.941,
            "unit_cost_inr": 8000,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "Very High",
            "notes": "Higher-grade concrete gives slender column sections with more floor area.",
        },
        {
            "material": "Steel Frame (MS)",
            "score": 0.876,
            "unit_cost_inr": 11000,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "High",
            "notes": "Structural steel columns for industrial or long-span applications.",
        },
        {
            "material": "Reinforced Concrete (M25)",
            "score": 0.812,
            "unit_cost_inr": 6800,
            "cost_label": "High",
            "strength_label": "Very High",
            "durability_label": "Very High",
            "notes": "Standard M25 columns; adequate for low-to-medium rise structures.",
        },
    ],
}

WEIGHT_PROFILES = {
    "load_bearing_wall": {"strength": 0.50, "durability": 0.30, "cost": 0.20},
    "partition_wall":    {"strength": 0.20, "durability": 0.30, "cost": 0.50},
    "slab":              {"strength": 0.50, "durability": 0.35, "cost": 0.15},
    "column":            {"strength": 0.55, "durability": 0.30, "cost": 0.15},
}


def _classify_wall(wall, idx, total):
    """Classify a wall segment as load-bearing or partition based on heuristics."""
    import math
    x1, y1 = wall["start"]["x"], wall["start"]["y"]
    x2, y2 = wall["end"]["x"],   wall["end"]["y"]
    length_px = math.hypot(x2 - x1, y2 - y1)

    is_outer  = idx < 4 or length_px > 180
    is_spine  = length_px > 260
    elem_type = "load_bearing_wall" if (is_outer or is_spine) else "partition_wall"

    PPM = 41.0  # pixels per metre (matches frontend SCALE constant)
    span_m  = round(length_px / PPM, 2)
    area_m2 = round(span_m * 3.0, 2)  # assume 3 m storey height

    concerns = []
    if is_outer and span_m > 8:
        concerns.append(f"Long outer wall ({span_m} m) — check deflection and lateral bracing.")
    if not is_outer and length_px < 60:
        concerns.append("Very short partition — verify minimum thickness for stability.")

    return {
        "element_id":      f"W{idx + 1:03d}",
        "element_type":    elem_type,
        "room_label":      f"{'Outer' if is_outer else 'Interior'} Wall {idx + 1}",
        "span_m":          span_m,
        "area_m2":         area_m2,
        "is_outer":        is_outer,
        "is_spine":        is_spine,
        "length_px":       round(length_px, 1),
        "start":           wall["start"],
        "end":             wall["end"],
        "concerns":        concerns,
        "weight_profile":  WEIGHT_PROFILES[elem_type],
        "recommendations": MATERIAL_DB[elem_type][:3],
    }


# ── New endpoints ─────────────────────────────────────────────────────────────

@app.route('/api/materials')
def get_materials():
    """
    Return structural material analysis for the floor plan.
    Shares image resolution logic with /api/data.
    """
    try:
        image_name = request.args.get('image', '')
        image_path = get_image_path(image_name)
        walls_data = get_wall_json(image_path)
        walls_list = walls_data.get("walls", [])

        analysis = [_classify_wall(w, i, len(walls_list)) for i, w in enumerate(walls_list)]

        lb_count = sum(1 for e in analysis if e["element_type"] == "load_bearing_wall")
        pt_count = sum(1 for e in analysis if e["element_type"] == "partition_wall")

        summary = {
            "total_elements":     len(analysis),
            "load_bearing_walls": lb_count,
            "partition_walls":    pt_count,
            "slabs":              0,
            "columns":            0,
        }

        return jsonify({
            "status":   "success",
            "summary":  summary,
            "analysis": analysis,
            "walls": [
                {
                    "element_id":   e["element_id"],
                    "element_type": e["element_type"],
                    "start":        e["start"],
                    "end":          e["end"],
                    "span_m":       e["span_m"],
                    "is_outer":     e["is_outer"],
                    "is_spine":     e["is_spine"],
                }
                for e in analysis
            ],
        })
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/chat', methods=['POST'])
def chat():
    """
    AI chat about a structural element.
    Uses Gemini if GEMINI_API_KEY env var is set; rule-based fallback otherwise.
    """
    try:
        body     = request.get_json(force=True) or {}
        question = (body.get('question') or '').strip()
        element  = body.get('element') or {}

        if not question:
            return jsonify({"answer": "Please ask a question."}), 400

        # Try Gemini first
        try:
            from dotenv import load_dotenv
            load_dotenv(override=True)
        except ImportError:
            pass
        
        api_key = os.environ.get('GEMINI_API_KEY', '')
        if api_key:
            try:
                import google.generativeai as genai
                genai.configure(api_key=api_key)
                model = genai.GenerativeModel('gemini-2.5-flash')
                recs = element.get('recommendations') or [{}]
                prompt = (
                    "You are a structural engineering assistant specialising in Indian "
                    "construction materials and building codes (IS 456, IS 800).\n\n"
                    f"Structural element details:\n"
                    f"  ID: {element.get('element_id', '?')}\n"
                    f"  Type: {element.get('element_type', '?').replace('_', ' ')}\n"
                    f"  Span: {element.get('span_m', '?')} m\n"
                    f"  Area: {element.get('area_m2', '?')} m²\n"
                    f"  Coordinates (Start): {element.get('start', '?')}\n"
                    f"  Coordinates (End): {element.get('end', '?')}\n"
                    f"  Length (Pixels): {element.get('length_px', '?')} px\n"
                    f"  Outer wall: {element.get('is_outer', '?')}\n"
                    f"  Top material: {recs[0].get('material', '?')}\n"
                    f"  Concerns: {'; '.join(element.get('concerns') or ['None'])}\n\n"
                    f"User question: {question}\n\n"
                    "Give a concise, practical response (2-4 sentences). "
                    "Use INR costs and IS codes where relevant."
                )
                response = model.generate_content(prompt)
                return jsonify({"answer": response.text})
            except Exception as gem_err:
                print(f"[Gemini] Error: {gem_err}")

        # Rule-based fallback
        q = question.lower()
        el_type  = element.get('element_type', 'wall').replace('_', ' ')
        recs     = element.get('recommendations') or [{}]
        top_mat  = recs[0].get('material', 'reinforced concrete')
        top_cost = recs[0].get('unit_cost_inr', 0)
        span     = element.get('span_m', '?')

        if any(w in q for w in ['cost', 'price', 'expensive', 'cheap', 'budget']):
            answer = (
                f"For a {el_type} of {span} m span, {top_mat} is the top recommendation "
                f"at \u20b9{top_cost:,}/m\u00b3. "
                "Fly Ash Bricks are the most budget-friendly option for non-load-bearing "
                "partitions starting around \u20b92,100/m\u00b3."
            )
        elif any(w in q for w in ['strength', 'strong', 'load', 'bearing', 'structural']):
            answer = (
                f"{top_mat} offers the highest structural performance for this {el_type}. "
                f"It meets IS 456 requirements for a {span} m span. "
                "Ensure adequate reinforcement and proper curing for full design strength."
            )
        elif any(w in q for w in ['seismic', 'earthquake', 'zone']):
            answer = (
                f"For seismic zones III-V in India, {top_mat} with ductile detailing "
                f"per IS 13920 is recommended for {el_type}s. "
                "Avoid unreinforced masonry for load-bearing walls in high seismic areas."
            )
        elif any(w in q for w in ['insulation', 'thermal', 'heat', 'temperature']):
            answer = (
                "AAC Block Walls provide the best thermal insulation for partition walls. "
                f"For {el_type}s consider adding 50 mm EPS insulation to conventional concrete walls."
            )
        elif any(w in q for w in ['fire', 'safety']):
            answer = (
                "Reinforced Concrete and Brick Masonry offer excellent fire resistance (2-4 hours). "
                "Steel frames require additional fireproofing spray above 550 C per IS 1641."
            )
        else:
            answer = (
                f"For this {el_type} ({span} m span), {top_mat} is the optimal choice "
                "based on strength, durability, and cost scoring. "
                "Click any material card to see pros/cons and the radar chart. "
                "Set GEMINI_API_KEY on the backend for AI-powered answers."
            )

        return jsonify({"answer": answer})

    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"answer": f"Server error: {e}"}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)