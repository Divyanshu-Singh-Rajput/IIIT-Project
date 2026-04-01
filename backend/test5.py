import cv2
img = cv2.imread('test/F1.png')
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
print("Pixel values along Y=165, X=130 to 170:")
print(gray[165, 130:170])
