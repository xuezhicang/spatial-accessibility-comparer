from flask import Flask, request, jsonify, send_file, after_this_request
from flask_cors import CORS
import os
import uuid
import geopandas as gpd
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge
import numpy as np
import pandas as pd

app = Flask(__name__)
# CORS(app,origins=["https://webgis.xuezhicang.com"])
CORS(app)

app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024 # max allowed size is 50 MB

app_location = "/home/ubuntu/geoapp/geoapp_script"

UPLOAD_DIR = os.path.join(app_location,"uploads")
OUTPUT_DIR = os.path.join(app_location,"outputs")

os.makedirs(UPLOAD_DIR, exist_ok=True) # we create the folders if they don't exist, but we won't use them as permanent storage, we will delete the files after processing
os.makedirs(OUTPUT_DIR, exist_ok=True) # we create the folders if they don't exist, but we won't use them as permanent storage, we will delete the files after processing


@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(e):
    return jsonify({"error": "Uploaded file is too large. Max size is 50MB."}), 413


def add_quartile_class(
    gdf: gpd.GeoDataFrame,
    score_col: str,
    class_col: str,
) -> gpd.GeoDataFrame:
    """
    Add quartile-based class column:
    1 = Low, 2 = Medium Low, 3 = Medium High, 4 = High
    """
    result = gdf.copy()

    scores = result[score_col].replace([np.inf, -np.inf], np.nan)
    result[class_col] = pd.Series([pd.NA] * len(result), dtype="Int64")

    valid = scores.notna()

    # rank first so qcut still works even when many values are duplicated
    ranked = scores[valid].rank(method="first")

    result.loc[valid, class_col] = pd.qcut(ranked,4,labels=[1, 2, 3, 4]).astype("Int64")

    return result


def two_step_fca(
    facility_gdf: gpd.GeoDataFrame,
    population_gdf: gpd.GeoDataFrame,
    supply_col: str,
    population_col: str,
    catchment_km: float,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """
    Compute classic 2SFCA (Two-Step Floating Catchment Area) accessibility.

    Parameters
    ----------
    facility_gdf : GeoDataFrame
        Facility layer with Point geometries in lon/lat (EPSG:4326 or equivalent).
    population_gdf : GeoDataFrame
        Population layer with Polygon geometries in lon/lat.
        Polygon centroids are used as demand locations.
    supply_col : str
        Column in facility_gdf representing facility supply/capacity.
    population_col : str
        Column in population_gdf representing demand/population.
    catchment_km : float
        Catchment/search radius in kilometers.

    Returns
    -------
    population_result : GeoDataFrame
        Copy of population_gdf with added columns:
        - centroid_lon
        - centroid_lat
        - accessible_facility_n
        - 2sfca
    facility_result : GeoDataFrame
        Copy of facility_gdf with added columns:
        - facility_lon
        - facility_lat
        - catchment_pop
        - provider_ratio
    """


    # Work on copies
    fac = facility_gdf.copy()
    pop = population_gdf.copy()

    # -----------------------------
    # Prepare coordinates
    # -----------------------------
    # Facility coordinates
    fac["facility_lon"] = fac.geometry.x
    fac["facility_lat"] = fac.geometry.y

    # Population centroid coordinates
    # Note: centroid on geographic CRS is an approximation.
    centroids = pop.geometry.centroid
    pop["centroid_lon"] = centroids.x
    pop["centroid_lat"] = centroids.y

    # Numeric arrays
    fac_lon = fac["facility_lon"].to_numpy(dtype=float)
    fac_lat = fac["facility_lat"].to_numpy(dtype=float)
    fac_supply = fac[supply_col].to_numpy(dtype=float)

    pop_lon = pop["centroid_lon"].to_numpy(dtype=float)
    pop_lat = pop["centroid_lat"].to_numpy(dtype=float)
    pop_demand = pop[population_col].to_numpy(dtype=float)

    # -----------------------------
    # Haversine distance matrix
    # rows = population, cols = facility
    # -----------------------------
    def haversine_matrix(lat1, lon1, lat2, lon2):
        """
        Compute pairwise great-circle distance matrix in kilometers.
        lat1/lon1: arrays of size N
        lat2/lon2: arrays of size M
        returns: (N, M) array
        """
        R = 6371.0088  # mean Earth radius in km

        lat1_rad = np.radians(lat1)[:, None]
        lon1_rad = np.radians(lon1)[:, None]
        lat2_rad = np.radians(lat2)[None, :]
        lon2_rad = np.radians(lon2)[None, :]

        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad

        a = (
            np.sin(dlat / 2.0) ** 2
            + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2.0) ** 2
        )
        c = 2 * np.arcsin(np.sqrt(a))
        return R * c

    dist_km = haversine_matrix(pop_lat, pop_lon, fac_lat, fac_lon)

    # mask[i, j] = population i is within facility j catchment
    within = dist_km <= catchment_km

    # -----------------------------
    # Step 1: facility provider ratio
    # R_j = S_j / sum(P_k within d0 of j)
    # -----------------------------
    catchment_pop = (within * pop_demand[:, None]).sum(axis=0)

    provider_ratio = np.divide(
        fac_supply,
        catchment_pop,
        out=np.zeros_like(fac_supply, dtype=float),
        where=catchment_pop > 0,
    )

    fac["catchment_pop"] = catchment_pop
    fac["provider_ratio"] = provider_ratio

    # -----------------------------
    # Step 2: population accessibility
    # A_i = sum(R_j for facilities j within d0 of i)
    # -----------------------------
    accessibility = (within * provider_ratio[None, :]).sum(axis=1)

    pop["accessible_facility_n"] = within.sum(axis=1)
    pop["2sfca"] = accessibility
    pop = add_quartile_class(pop, "2sfca", "2sfca_class")


    return pop, fac


def gravity_accessibility(
    facility_gdf: gpd.GeoDataFrame,
    population_gdf: gpd.GeoDataFrame,
    supply_col: str,
    population_col: str,
    beta: float = 2.0,
    max_distance_km: float | None = None,
) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """
    Compute gravity-model accessibility with optional supply-demand balancing.

    Parameters
    ----------
    facility_gdf : GeoDataFrame
        Facility layer with Point geometries in lon/lat.
    population_gdf : GeoDataFrame
        Population layer with Polygon geometries in lon/lat.
        Polygon centroids are used as demand locations.
    supply_col : str
        Facility supply/capacity column.
    population_col : str
        Population/demand column.
    beta : float
        Distance-decay exponent in d^-beta.
    facility_id_col : str | None
        Optional facility ID column.
    population_id_col : str | None
        Optional population ID column.
    max_distance_km : float | None
        Optional cutoff distance. If provided, weights beyond this distance are set to 0.

    Returns
    -------
    population_result : GeoDataFrame
        Population layer with:
        - centroid_lon
        - centroid_lat
        - gravity_access
    facility_result : GeoDataFrame
        Facility layer with:
        - facility_lon
        - facility_lat
        - weighted_catchment_pop
        - provider_ratio_gravity
    """

    if facility_gdf.empty:
        raise ValueError("facility_gdf is empty.")
    if population_gdf.empty:
        raise ValueError("population_gdf is empty.")
    if supply_col not in facility_gdf.columns:
        raise KeyError(f"'{supply_col}' not found in facility_gdf.")
    if population_col not in population_gdf.columns:
        raise KeyError(f"'{population_col}' not found in population_gdf.")
    if beta <= 0:
        raise ValueError("beta must be > 0.")

    if not all(facility_gdf.geometry.geom_type == "Point"):
        raise ValueError("All geometries in facility_gdf must be Point.")

    fac = facility_gdf.copy()
    pop = population_gdf.copy()

    fac["facility_lon"] = fac.geometry.x
    fac["facility_lat"] = fac.geometry.y

    centroids = pop.geometry.centroid
    pop["centroid_lon"] = centroids.x
    pop["centroid_lat"] = centroids.y

    fac_lon = fac["facility_lon"].to_numpy(dtype=float)
    fac_lat = fac["facility_lat"].to_numpy(dtype=float)
    fac_supply = fac[supply_col].to_numpy(dtype=float)

    pop_lon = pop["centroid_lon"].to_numpy(dtype=float)
    pop_lat = pop["centroid_lat"].to_numpy(dtype=float)
    pop_demand = pop[population_col].to_numpy(dtype=float)

    def haversine_matrix(lat1, lon1, lat2, lon2):
        R = 6371.0088
        lat1_rad = np.radians(lat1)[:, None]
        lon1_rad = np.radians(lon1)[:, None]
        lat2_rad = np.radians(lat2)[None, :]
        lon2_rad = np.radians(lon2)[None, :]
        dlat = lat2_rad - lat1_rad
        dlon = lon2_rad - lon1_rad
        a = (
            np.sin(dlat / 2.0) ** 2
            + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlon / 2.0) ** 2
        )
        c = 2 * np.arcsin(np.sqrt(a))
        return R * c

    dist_km = haversine_matrix(pop_lat, pop_lon, fac_lat, fac_lon)

    # Avoid division by zero for coincident points
    eps = 1e-6
    safe_dist = np.maximum(dist_km, eps)

    # Gravity weights
    weights = safe_dist ** (-beta)

    if max_distance_km is not None:
        if max_distance_km <= 0:
            raise ValueError("max_distance_km must be > 0.")
        weights = np.where(dist_km <= max_distance_km, weights, 0.0)

    # Step 1: facility-side weighted demand
    weighted_catchment_pop = (weights * pop_demand[:, None]).sum(axis=0)

    provider_ratio_gravity = np.divide(
        fac_supply,
        weighted_catchment_pop,
        out=np.zeros_like(fac_supply, dtype=float),
        where=weighted_catchment_pop > 0,
    )

    fac["weighted_catchment_pop"] = weighted_catchment_pop
    fac["provider_ratio_gravity"] = provider_ratio_gravity

    # Step 2: population accessibility
    gravity_access = (weights * provider_ratio_gravity[None, :]).sum(axis=1)

    pop["gravity_access"] = gravity_access
    pop = add_quartile_class(pop, "gravity_access", "gravity_access_class")

    return pop, fac


# get the data and call the 2step floating method
@app.route("/api/measure_accessibility", methods=["POST"])
def measure_accessibility():
    if "file_1" not in request.files or "file_2" not in request.files:
        return jsonify({"error": "Both file_1 and file_2 are required"}), 400

    file_1 = request.files["file_1"]   # facility
    file_2 = request.files["file_2"]   # population

    supply_col = request.form["file_1_col"]
    population_col = request.form["file_2_col"]
    catchment_km =  float(request.form["catchment_km"])
    beta = float(request.form["beta"])


    filename_1 = secure_filename(file_1.filename)
    filename_2 = secure_filename(file_2.filename)

    if not filename_1 or not filename_2:
        return jsonify({"error": "Invalid file name"}), 400

    input_path_1 = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}_{filename_1}")
    input_path_2 = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}_{filename_2}")

    output_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4()}_accessibility.gpkg")
    p1_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4()}_p1.gpkg")
    p2_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4()}_p2.gpkg")

    try:
        file_1.save(input_path_1)
        file_2.save(input_path_2)

        facility_gdf = gpd.read_file(input_path_1)
        population_gdf = gpd.read_file(input_path_2)

        if facility_gdf.empty:
            return jsonify({"error": "file_1 is empty"}), 400
        if population_gdf.empty:
            return jsonify({"error": "file_2 is empty"}), 400

        if facility_gdf.crs is None or population_gdf.crs is None:
            return jsonify({"error": "Uploaded file has no CRS"}), 400

        facility_gdf = facility_gdf.to_crs(epsg=4326)
        population_gdf = population_gdf.to_crs(epsg=4326)



        # 1) run 2SFCA
        pop_2sfca, fac_2sfca = two_step_fca(
            facility_gdf=facility_gdf.copy(),
            population_gdf=population_gdf.copy(),
            supply_col=supply_col,
            population_col=population_col,
            catchment_km=catchment_km,
        )
        pop_2sfca.to_file(p1_path, driver="GPKG")

        # 2) run gravity
        pop_gravity, fac_gravity = gravity_accessibility(
            facility_gdf=facility_gdf.copy(),
            population_gdf=population_gdf.copy(),
            supply_col=supply_col,
            population_col=population_col,
            beta=beta,
            max_distance_km=catchment_km,
        )
        pop_gravity.to_file(p2_path, driver="GPKG")

        # clean inf values before writing
        pop_2sfca = pop_2sfca.replace([np.inf, -np.inf], np.nan)
        fac_2sfca = fac_2sfca.replace([np.inf, -np.inf], np.nan)
        pop_gravity = pop_gravity.replace([np.inf, -np.inf], np.nan)
        fac_gravity = fac_gravity.replace([np.inf, -np.inf], np.nan)

        # write all results into one GeoPackage
        # keep geometry from one population layer, attach gravity result columns
        pop_merged = pop_2sfca.copy()

        # add gravity fields except geometry
        gravity_cols = [col for col in pop_gravity.columns if col != "geometry"]
        for col in gravity_cols:
            if col in pop_merged.columns:
                pop_merged[f"{col}_gravity"] = pop_gravity[col]
            else:
                pop_merged[col] = pop_gravity[col]
        pop_merged.to_file(output_path, layer="population_accessibility", driver="GPKG")



        @after_this_request
        def cleanup(response):
            for path in [input_path_1, input_path_2, output_path, p1_path, p2_path]:
                if path and os.path.exists(path):
                    try:
                        print(f"Cleaning up file: {path}", flush=True)
                        os.remove(path)
                    except Exception as cleanup_err:
                        print("Cleanup error:", cleanup_err, flush=True)
            return response

        return send_file(
            output_path,
            as_attachment=True,
            download_name="accessibility.gpkg",
            mimetype="application/geopackage+sqlite3"
        )

    except Exception as e:
        print("ERROR:", str(e), flush=True)
        return jsonify({"error": str(e)}), 500





# upload the geopackage and reproject it to the target epsg, then return the reprojected file
@app.route("/api/upload", methods=["POST"])
def upload_file():
    # print("1. request received", flush=True)

    if "file" not in request.files:
        # print("2. no file uploaded", flush=True)
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    filename = secure_filename(file.filename)
    # print(f"3. filename = {filename}", flush=True)

    if not filename:
        # print("4. empty filename", flush=True)
        return jsonify({"error": "Empty filename"}), 400

    input_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}_{filename}")
    file.save(input_path)
    # print(f"file saved to {input_path}", flush=True)

    target_epsg = request.form.get("epsg", "4326")
    # print(f"target_epsg = {target_epsg}", flush=True)

    output_path = None

    try:
        # print("7. start read_file", flush=True)
        gdf = gpd.read_file(input_path)
        print("read_file done", flush=True)

        # print(f"rows  {len(gdf)}", flush=True)
        # print(f"crs = {gdf.crs}", flush=True)

        if gdf.crs is None:
            print("11. no CRS", flush=True)
            return jsonify({"error": "No CRS in uploaded file"}), 400

        gdf = gdf.to_crs(epsg=int(target_epsg))
        print("to_crs done", flush=True)

        output_path = os.path.join(OUTPUT_DIR, f"{uuid.uuid4()}_converted.gpkg")
        print(f"14. start to_file -> {output_path}", flush=True)
        gdf.to_file(output_path, driver="GPKG")
        print("15. to_file done", flush=True)

        @after_this_request
        def cleanup(response):
            try:
                if os.path.exists(input_path):
                    os.remove(input_path)
                if output_path and os.path.exists(output_path):
                    os.remove(output_path)
            except Exception as e:
                print("Cleanup error:", e, flush=True)
            return response

        print("sending file to frontend", flush=True)
        return send_file(
            output_path,
            as_attachment=True,
            download_name="converted.gpkg",
            mimetype="application/geopackage+sqlite3"
        )

    except Exception as e:
        print("ERROR:", str(e), flush=True)

        if os.path.exists(input_path):
            try:
                os.remove(input_path)
            except Exception as cleanup_err:
                print("Input cleanup error:", cleanup_err, flush=True)

        if output_path and os.path.exists(output_path):
            try:
                os.remove(output_path)
            except Exception as cleanup_err:
                print("Output cleanup error:", cleanup_err, flush=True)

        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)