from wall_detector import get_wall_json
data = get_wall_json('test/F1.png')
with open('temp_out_python.txt', 'w', encoding='utf-8') as f:
    f.write(f"Total walls: {len(data.get('walls', []))}\n")
    for w in data.get("walls", []):
        if w["start"]["y"] > 160 and w["start"]["y"] < 170 and w["type"] == "horizontal":
            f.write(f"{w}\n")
