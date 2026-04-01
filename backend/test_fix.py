from wall_detector import get_wall_json
import json
data = get_wall_json('test/F1.png')
print("Total walls:", len(data.get("walls", [])))
for w in data.get("walls", []):
    # just print walls around y=165 where the gap was
    if w["start"]["y"] > 160 and w["start"]["y"] < 170 and w["type"] == "horizontal":
        print(w)
