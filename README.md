# Spatial Accessibility Comparer (Web GIS)

## Overview
This is a web-based GIS tool I built to explore spatial accessibility to facilities (e.g., hospitals). It lets users upload spatial data, run accessibility analysis, and visualize results directly in the browser.

The goal was to create something practical for research use, especially in public health and urban studies.

---

## What it does
- Upload GeoPackage (.gpkg) datasets (facility + population)
- Compute accessibility using:
  - 2SFCA (Two-Step Floating Catchment Area)
  - Gravity-based model
- Visualize results on an interactive map
- Compare both methods using bivariate mapping
- Export results for further GIS analysis

---

## Tech stack
- Python (Flask, GeoPandas, NumPy, Pandas)
- JavaScript (OpenLayers)
- HTML / CSS

---

