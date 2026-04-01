import cv2
import numpy as np
from wall_detector import get_wall_json

img = cv2.imread('test/F1.png')
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
_, mask = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
kernel = np.ones((3,3), np.uint8)
mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
clean_mask = np.zeros_like(mask)
for i in range(1, num_labels):
    if stats[i, cv2.CC_STAT_AREA] > 100: 
        clean_mask[labels == i] = 255

skeleton = cv2.ximgproc.thinning(clean_mask) if hasattr(cv2, 'ximgproc') else clean_mask

lines = cv2.HoughLinesP(skeleton, 1, np.pi/180, threshold=20, 
                        minLineLength=10, maxLineGap=15)
                        
with open("temp_hough_utf8.txt", "w", encoding="utf-8") as f:
    if lines is not None:
        for l in lines:
            x1, y1, x2, y2 = l[0]
            if y1 > 160 and y1 < 170 and y2 > 160 and y2 < 170:
                f.write(f"Hough: {x1}, {y1} -> {x2}, {y2}\n")
