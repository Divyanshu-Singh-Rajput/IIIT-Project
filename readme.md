🏗️ Floor Plan Parser & Intelligent 3D Structural Analyzer

An end-to-end system that converts 2D floor plans into interactive 3D models and performs intelligent structural and material analysis.

This project combines computer vision, geometric reconstruction, 3D rendering, and AI-driven material evaluation to bridge the gap between architectural design and structural insight.
🚀 Features

    📐 2D Floor Plan Parsing
        Detects walls, rooms, doors, and windows from floor plan images
        Uses computer vision techniques for spatial understanding

    🧩 Geometric Reconstruction
        Converts detected elements into structured geometry
        Represents floor plans as graphs (nodes = corners, edges = walls)

    🏢 3D Model Generation
        Transforms 2D layouts into 3D structures
        Interactive visualization using extrusion techniques

    🧠 Structural & Material Analysis

        Differentiates between load-bearing and non-load-bearing elements

        Evaluates materials (Brick, steel, RCC, etc.)

        Scores materials based on:
            Strength
            Cost
            Durability

        Provides ranked recommendations using LLM-based evaluation

🛠️ Tech Stack

    Computer Vision: OpenCV
    Geometry Processing: Shapely
    3D Rendering: Three.js
    AI/Analysis: LLM APIs

🔄 Pipeline Overview
1. Floor Plan Parsing

    Input: 2D floor plan image

    Process:
        Image preprocessing
        Edge detection & contour extraction
        Object detection (walls, rooms, doors, windows)

    Output: Structured layout data

2. Geometric Reconstruction

    Converts detected elements into a geometric graph:
        Nodes: Corners
        Edges: Walls

    Ensures spatial consistency and connectivity

    Generates a clean 2D structural representation

3. 3D Model Generation

    Uses extrusion techniques to convert 2D geometry into 3D
    Walls, doors, and windows are modeled with depth and height
    Rendered interactively using Three.js

4. Structural & Material Analysis

    Classifies:
        Load-bearing structures
        Non-load-bearing partitions

    Evaluates material options:
        Brick
        Steel
        RCC

    Computes a composite score based on:
        Structural strength
        Cost efficiency
        Durability

    Uses LLMs to:
        Rank materials
        Suggest optimal combinations

📊 Output

    Interactive 3D model of the floor plan
    Structural classification of elements
    Material recommendations with scoring and ranking

💡 Use Cases

    Architectural visualization
    Structural planning assistance
    Cost estimation & optimization
    Educational tools for civil engineering

⚠️ Limitations

    Accuracy depends on quality of input floor plan
    Complex layouts may require manual correction
    Material analysis is heuristic + AI-based (not a substitute for professional engineering validation)

🔮 Future Improvements

    Integration with CAD formats (DXF, DWG)
    Real-time editing of 3D models
    Physics-based structural simulation
    More precise cost modeling with regional pricing
