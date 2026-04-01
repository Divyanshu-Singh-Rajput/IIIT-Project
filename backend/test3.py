import cv2
import numpy as np

def test_gap(image_path):
    img = cv2.imread(image_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # 1. THRESHOLD & CLEAN
    _, mask = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
    kernel = np.ones((3,3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    # Let's count CCs
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean_mask = np.zeros_like(mask)
    small_comps = 0
    for i in range(1, num_labels):
        if stats[i, cv2.CC_STAT_AREA] > 100: 
            clean_mask[labels == i] = 255
        else:
            small_comps += 1
            
    # Check if there's a difference around x=137 to 163, y=160 to 170
    roi_mask = mask[160:170, 137:163]
    roi_clean = clean_mask[160:170, 137:163]
    print(f"White pixels in mask ROI: {np.count_nonzero(roi_mask)}")
    print(f"White pixels in clean_mask ROI: {np.count_nonzero(roi_clean)}")
    print(f"Total small components removed: {small_comps}")

test_gap('test/F1.png')
