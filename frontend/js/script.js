
    const colorRamp1 = [
      "#ffffcc",
      "#a1dab4",
      "#41b6c4",
      "#2c7fb8",
      "#253494"
    ];

    const colorRamp2 = [
      "#fff5f0",
      "#fcbba1",
      "#fc9272",
      "#fb6a4a",
      "#cb181d"
    ];


    // 1-1 (Low-Low)
    // 4-1 (Low y -High x)
    // 1-4 (High y -Low x)
    // 4-4 (High y -High x)
    const bluegill4 = [
      ['#d3d3d3', '#c2a0a6', '#b16d79', '#9e3547'],
      ['#a3b5c7', '#96899d', '#895e72', '#7a2d43'],
      ['#7397bb', '#697394', '#604e6b', '#56263f'],
      ['#4279b0', '#3c5c8b', '#373f65', '#311e3b']
    ];



    const DEFAULT_GPKG_Facility_LAYER = "https://raw.githubusercontent.com/xuezhicang/spatial-accessibility-comparer/main/data/examples/cook_hosptial_with_beds.gpkg";
    const DEFAULT_GPKG_Population_LAYER = "https://raw.githubusercontent.com/xuezhicang/spatial-accessibility-comparer/main/data/examples/cook_cenus_tract_with_pop.gpkg";



    async function getFileFromUrl(url, filename_url ) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to download sample data");
      }

      const blob = await response.blob();
      return new File([blob], filename_url, {
        type: "application/geopackage+sqlite3"
      });
    }


    function isNumeric(value) {
      return value !== null && value !== "" && !isNaN(Number(value));
    }

    function computeQuantileBreaks(features, fieldName, classes = 5) {
      const values = features
        .map(f => f.get(fieldName))
        .filter(v => isNumeric(v))
        .map(v => Number(v))
        .sort((a, b) => a - b);

      if (values.length === 0) return null;

      const breaks = [];

      for (let i = 1; i < classes; i++) {
        const index = Math.floor((i / classes) * values.length);
        breaks.push(values[index]);
      }

      return breaks; // e.g. [q20, q40, q60, q80]
    }


    function getColorForValue(value, min, max, colorRamp) {
      if (!isNumeric(value)) return "#cccccc";

      const num = Number(value);

      if (min === max) {
        return colorRamp[colorRamp.length - 1];
      }

      const ratio = (num - min) / (max - min);

      if (ratio <= 0.2) return colorRamp[0];
      if (ratio <= 0.4) return colorRamp[1];
      if (ratio <= 0.6) return colorRamp[2];
      if (ratio <= 0.8) return colorRamp[3];
      return colorRamp[4];
    }

    function getNumericFields(features) {
      const fieldMap = {};

      features.forEach(feature => {
        const props = feature.getProperties();

        Object.keys(props).forEach(key => {
          if (key === "geometry") return;

          if (!fieldMap[key]) {
            fieldMap[key] = { numericCount: 0 };
          }

          if (isNumeric(props[key])) {
            fieldMap[key].numericCount += 1;
          }
        });
      });

      return Object.keys(fieldMap).filter(key => fieldMap[key].numericCount > 0);
    }

    function computeFieldStats(features, fieldName) {
      const values = features
        .map(f => f.get(fieldName))
        .filter(v => isNumeric(v))
        .map(v => Number(v));

      if (values.length === 0) {
        return { min: null, max: null };
      }

      return {
        min: Math.min(...values),
        max: Math.max(...values)
      };
    }

    function updateLegend(legendEl, fieldName, min, max, colorRamp) {
      if (!fieldName || min === null || max === null) {
        legendEl.innerHTML = "Not available";
        return;
      }

      const breaks = [];
      for (let i = 0; i < 5; i++) {
        const start = min + (max - min) * (i / 5);
        const end = min + (max - min) * ((i + 1) / 5);
        breaks.push([start, end]);
      }

      legendEl.innerHTML = `
        <div style="margin-top:6px;">Field: <strong>${fieldName}</strong></div>
        ${breaks.map((b, i) => `
          <div class="legend-row">
            <div class="legend-color" style="background:${colorRamp[i]}"></div>
            <div>${b[0].toFixed(0)} - ${b[1].toFixed(0)}</div>
          </div>
        `).join("")}
      `;
    }


    function getBivariateColor(feature, fieldX, fieldY, matrix) {
      const xClass = Number(feature.get(fieldX));
      const yClass = Number(feature.get(fieldY));

      if (!Number.isFinite(xClass) || !Number.isFinite(yClass)) {
        return "#cccccc";
      }

      const size = matrix.length;

      // assuming class values are 1..4 or 1..5
      const x = xClass - 1;
      const y = yClass - 1;

      if (x < 0 || y < 0 || x >= size || y >= size) {
        return "#cccccc";
      }

      // row = y class, col = x class
      return matrix[y][x];
    }


    function createAccessibilityStyle(feature, state) {
      const fillColor = getBivariateColor(
        feature,
        state.Field_2sfca,
        state.Field_gravity,
        bluegill4 // or bluegill5 if your backend outputs 1..5 classes
      );

      return new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: "#333333",
          width: 1.2
        }),
        fill: new ol.style.Fill({
          color: fillColor
        }),
        image: new ol.style.Circle({
          radius: 10,
          fill: new ol.style.Fill({ color: fillColor }),
          stroke: new ol.style.Stroke({
            color: "#ffffff",
            width: 1
          })
        })
      });
    }


    function createLayerStyle(feature, state) {
      let fillColor = "rgba(255,102,0,0.2)";
      let strokeColor = "#666";

      if (state.currentField && state.stats.min !== null && state.stats.max !== null) {
        const value = feature.get(state.currentField);
        fillColor = getColorForValue(value, state.stats.min, state.stats.max, state.colorRamp);
        strokeColor = "#333333";
      }

      return new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: strokeColor,
          width: 1.5
        }),
        fill: new ol.style.Fill({
          color: fillColor
        }),
        image: new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({
            color: fillColor
          }),
          stroke: new ol.style.Stroke({
            color: "#ffffff",
            width: 1
          })
        })
      });
    }

    const layerState1 = {
      source: new ol.source.Vector(),
      layer: null,
      file: null,
      currentField: null,
      stats: { min: null, max: null },
      colorRamp: colorRamp1,
      statusEl: document.getElementById("status1"),
      fieldSelectEl: document.getElementById("fieldSelect1"),
      legendEl: document.getElementById("legendContent1"),
      toggleEl: document.getElementById("toggleLayer1")
    };

    const layerState2 = {
      source: new ol.source.Vector(),
      layer: null,
      file: null,
      currentField: null,
      stats: { min: null, max: null },
      colorRamp: colorRamp2,
      statusEl: document.getElementById("status2"),
      fieldSelectEl: document.getElementById("fieldSelect2"),
      legendEl: document.getElementById("legendContent2"),
      toggleEl: document.getElementById("toggleLayer2")
    };


    const layerState3 = {
      source: new ol.source.Vector(),
      layer: null,
      currentField: null,
      Field_2sfca: null,
      Field_gravity: null,
      stats: { min: null, max: null },
      colorRamp: colorRamp2,
      statusEl: document.getElementById("status3"),
      legendEl: document.getElementById("legendContent3"),
      toggleEl: document.getElementById("toggleLayer3")
    };



    layerState1.layer = new ol.layer.Vector({
      source: layerState1.source,
      visible: true,
      style: function(feature) {
        return createLayerStyle(feature, layerState1);
      }
    });

    layerState2.layer = new ol.layer.Vector({
      source: layerState2.source,
      visible: true,
      style: function(feature) {
        return createLayerStyle(feature, layerState2);
      }
    });

    layerState3.layer = new ol.layer.Vector({
      source: layerState3.source,
      visible: true,
      style: function(feature) {
        return createAccessibilityStyle(feature, layerState3);
      }
    });


    const panelLayerMap = {
    layer1: layerState1.layer, // Facility
    layer2: layerState2.layer, // Population
    layer3: layerState3.layer  // Accessibility
    };


    const map = new ol.Map({
      target: "map",
      layers: [
        new ol.layer.Tile({
          source: new ol.source.OSM()
        }),
        layerState2.layer,
        layerState3.layer,
        layerState1.layer,
        
      ],

      view: new ol.View({
        center: ol.proj.fromLonLat([0, 0]),
        zoom: 2
      })
    });

    function setStatus(state, msg) {
      state.statusEl.textContent = msg;
      console.log(msg);
    }
    


  function updateLayerOrderFromPanel() {
    const items = [...document.querySelectorAll("#layerList .layer-item")];

    // top item in panel should draw on top on map
    items.forEach((item, index) => {
      const layerId = item.dataset.layerId;
      const layer = panelLayerMap[layerId];
      if (layer) {
        layer.setZIndex(items.length - index);
      }
    });
  }


  function initLayerDragAndDrop() {
    const layerList = document.getElementById("layerList");
    let draggedItem = null;

    layerList.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".layer-item");
      if (!item) return;
      draggedItem = item;
      item.classList.add("dragging");
    });

    layerList.addEventListener("dragend", (e) => {
      const item = e.target.closest(".layer-item");
      if (item) item.classList.remove("dragging");
      draggedItem = null;
      updateLayerOrderFromPanel();
    });

    layerList.addEventListener("dragover", (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(layerList, e.clientY);
      if (!draggedItem) return;

      if (afterElement == null) {
        layerList.appendChild(draggedItem);
      } else {
        layerList.insertBefore(draggedItem, afterElement);
      }
    });
  }

  function getDragAfterElement(container, y) {
    const draggableElements = [
      ...container.querySelectorAll(".layer-item:not(.dragging)")
    ];

    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }



    function numericFieldSelector(state) {
      const features = state.source.getFeatures();
      const numericFields = getNumericFields(features);
      const select = state.fieldSelectEl;

      select.innerHTML = "";

      if (numericFields.length === 0) {
        select.disabled = true;
        select.innerHTML = `<option value="">No numeric fields found</option>`;
        state.currentField = null;
        state.stats = { min: null, max: null };
        updateLegend(state.legendEl, null, null, null, state.colorRamp);
        state.layer.changed();
        return;
      }

      select.disabled = false;
      select.innerHTML = `<option value="">Please select a field</option>`;

      numericFields.forEach(field => {
        const option = document.createElement("option");
        option.value = field;
        option.textContent = field;
        select.appendChild(option);
      });
    }

    function zoomToLoadedLayers() {
      let extent = null;

      [layerState1, layerState2].forEach(state => {
        if (state.source.getFeatures().length > 0) {
          const e = state.source.getExtent();
          if (!extent) {
            extent = e.slice();
          } else {
            ol.extent.extend(extent, e);
          }
        }
      });

      if (extent) {
        map.getView().fit(extent, {
          padding: [40, 40, 40, 40],
          duration: 500,
          maxZoom: 17
        });
      }
    }

    // GeoPackage setup
    const gpkgLib = window.GeoPackage || {};
    console.log("window.GeoPackage =", gpkgLib);

    if (gpkgLib.setSqljsWasmLocateFile) {
      gpkgLib.setSqljsWasmLocateFile(function(file) {
        return "https://cdn.jsdelivr.net/npm/@ngageoint/geopackage@4.2.6/dist/" + file;
      });
    }

    async function openGeoPackage(uint8Array) {
      if (gpkgLib.GeoPackageAPI && typeof gpkgLib.GeoPackageAPI.open === "function") {
        return await gpkgLib.GeoPackageAPI.open(uint8Array);
      }

      if (gpkgLib.GeoPackageManager && typeof gpkgLib.GeoPackageManager.open === "function") {
        return await gpkgLib.GeoPackageManager.open(uint8Array);
      }

      throw new Error("GeoPackage open API not found in window.GeoPackage");
    }





      async function sendToBackendAndDisplay(file,state) {
        try {
        setStatus(state, "Uploading GeoPackage to backend...");

        const formData = new FormData();
        formData.append("file", file);

        // given the target projection
        formData.append("epsg", "4326");

        // Change this URL if your backend is on another host or port
        const response = await fetch("https://webgis.xuezhicang.com/api/upload", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            let errorMessage = "Backend request failed";
            try {
            const errorJson = await response.json();
            errorMessage = errorJson.error || errorMessage;
            } catch (e) {}
            throw new Error(errorMessage);
        }

        setStatus(state, "Received processed GeoPackage from backend...");
        const buffer = await response.arrayBuffer();
        return buffer;
        // await renderGeoPackageFromBuffer(buffer);

        } 
        catch (err) {
        console.error("sendToBackendAndDisplay error:", err);
        setStatus(state, "Error: " + err.message);
        }
      }


function updateBivariateLegend(legendEl, matrix, xLabel, yLabel) {
  const cellSize = 42;
  const labels = [1, 2, 3, 4];

  const xLabelText = xLabel || "2SFCA (Low → High)";
  const yLabelText = yLabel || "Gravity (Low → High)";

  // 左边 y 轴标签：上到下 4,3,2,1
  const yTicksHtml = [4, 3, 2, 1].map(v => `
    <div class="bivariate-legend-ytick" style="height:${cellSize}px; width:90px;">
      <span><b>${v}</b> - ${getClassLabel(v)}</span>
    </div>
  `).join("");

  // 中间矩阵：把 matrix 反过来，这样高值在上面
  const rowsHtml = [...matrix].reverse().map(row => `
    <div class="bivariate-legend-row">
      ${row.map(color => `
        <div
          class="bivariate-legend-cell"
          style="width:${cellSize}px; height:${cellSize}px; background:${color};">
        </div>
      `).join("")}
    </div>
  `).join("");

  // 下边 x 轴标签：左到右 1,2,3,4
  const xTicksHtml = labels.map(v => `
    <div class="bivariate-legend-xtick" style="width:${cellSize}px;">
      <div class="bivariate-legend-xtick-num">${v}</div>
      <div>${getClassLabel(v)}</div>
    </div>
  `).join("");

  legendEl.innerHTML = `
    <div class="bivariate-legend-wrap">
      <div class="bivariate-legend-ytitle" style="height:${cellSize * 4}px;">
        ${yLabelText}
      </div>

      <div class="bivariate-legend-yticks">
        ${yTicksHtml}
      </div>

      <div class="bivariate-legend-main">
        <div class="bivariate-legend-matrix" style="width:${cellSize * 4}px;">
          ${rowsHtml}
        </div>

        <div class="bivariate-legend-xticks" style="width:${cellSize * 4}px;">
          ${xTicksHtml}
        </div>

        <div class="bivariate-legend-xtitle">
          ${xLabelText}
        </div>
      </div>
    </div>
  `;
}



    async function loadGeoPackageToState(file, state, layerName) {
      

      try {
        setStatus(state, `Opening ${layerName}...`);
        state.source.clear();
        state.currentField = null;
        state.stats = { min: null, max: null };
        
        // if (layerName === "accesslibility Layer") {
        //   layerState3.currentField = "2sfca";
        // }
        // else{
        //   state.fieldSelectEl.disabled = true;
        //   state.fieldSelectEl.innerHTML = `<option value="">Loading...</option>`;
        //   // updateLegend(state.legendEl, null, null, null, state.colorRamp);
        // }

        const buffer = await sendToBackendAndDisplay(file, state);
        const gpkg = await openGeoPackage(new Uint8Array(buffer));

        if (!gpkg) {
          throw new Error("Failed to open GeoPackage");
        }

        const tables = gpkg.getFeatureTables();
        console.log(layerName + " feature tables:", tables);

        // in this projet, we only return one layer, so if there are multiple layers, we throw an error
        if (tables.length > 1) {
          throw new Error("GeoPackage contains multiple layers. Only one layer is supported in this program.");
        }

        if (!tables || tables.length === 0) {
          setStatus(state, "No feature tables found in this GeoPackage.");
          return;
        }

        let totalCount = 0;
        const table = tables[0]; //only load the first layer

        const geojsonFormat = new ol.format.GeoJSON();

        // for (const table of tables) {
          setStatus(state, `Loading ${layerName} table: ${table}`);

          try {
              const featureDao = gpkg.getFeatureDao(table);
              const iterator = featureDao.queryForEach();

              for (const row of iterator) {
                const featureRow = featureDao.getRow(row);
                const geometry = featureRow.geometry;
                if (!geometry) continue;

                const geojson = geometry.toGeoJSON();
                const features = geojsonFormat.readFeatures(geojson, {
                  dataProjection: "EPSG:4326", // EPSG:4326 = WGS84 (GPS system)
                  featureProjection: "EPSG:3857" // EPSG:3857 = Web Mercator (used by OpenLayers)
                });

                const values = featureRow.values || {};
                for (const f of features) {
                  Object.keys(values).forEach(key => {
                    if (key !== "geometry") {
                      f.set(key, values[key]);
                    }
                  });
                  f.set("tableName", table);
                }

                state.source.addFeatures(features);
                totalCount += features.length;
              }
          } catch (tableError) {
            console.error(`Error loading table ${table}:`, tableError);
          }
        

        if (layerName === "accesslibility Layer") {
          state.Field_2sfca = "2sfca_class";
          state.Field_gravity = "gravity_access_class";

          // // biscaleFieldVis(state);
          // updateBivariateLegend(
          //   state.legendEl,
          //   bluegill4, // or bluegill5
          //   "2sfca_class",
          //   "gravity_access_class"
          // );
          const legendEl = document.getElementById("legendContent3");

          updateBivariateLegend(
          legendEl,
          bluegill4,
          "2SFCA (Low → High)",
          "Gravity (Low → High)"
        );

          


          state.layer.changed();

          // state.stats = computeFieldStats(state.source.getFeatures(), "2sfca");
        }
        else{
          numericFieldSelector(state);}

        if (totalCount > 0) {
          zoomToLoadedLayers();
          setStatus(state, `${layerName} loaded: ${totalCount} feature(s).`);
        } else {
          setStatus(state, "No valid features found.");
        }

      } catch (err) {
        console.error("loadGeoPackageToState error:", err);
        setStatus(state, "Error: " + err.message);
      }
    }



    function bindFieldSelector(state, layerName) {
      state.fieldSelectEl.addEventListener("change", function() {
        const fieldName = this.value;
        const features = state.source.getFeatures();

        if (!fieldName) {
          state.currentField = null;
          state.stats = { min: null, max: null };
          updateLegend(state.legendEl, null, null, null, state.colorRamp);
          state.layer.changed();
          setStatus(state, `${layerName} field-based rendering has been removed.`);
          return;
        }

        state.currentField = fieldName;
        state.stats = computeFieldStats(features, fieldName);
        updateLegend(state.legendEl, state.currentField, state.stats.min, state.stats.max, state.colorRamp);
        state.layer.changed();

        setStatus(
          state,
          `${layerName} is currently styled by the field"${fieldName}", range: ${state.stats.min} ~ ${state.stats.max}`
        );
      });
    }

    function bindLayerToggle(state, layerName) {
      state.toggleEl.addEventListener("change", function() {
        state.layer.setVisible(this.checked);
        setStatus(state, `${layerName} ` + (this.checked ? "is visible" : "is hidden"));
      });
    }
    
    function setFieldIfExists(state, fieldName) {
      const exists = [...state.fieldSelectEl.options].some(opt => opt.value === fieldName);
      if (exists) {
        state.fieldSelectEl.value = fieldName;
        state.fieldSelectEl.dispatchEvent(new Event("change"));
      }
    }

    function moveAccessibilityToTop() {
      const layerList = document.getElementById("layerList");
      const accessibilityItem = layerList?.querySelector('[data-layer-id="layer3"]');

      if (!layerList || !accessibilityItem) {
        return;}

      // put accessibility at the top of the legend panel
      layerList.prepend(accessibilityItem);
    }


    bindFieldSelector(layerState1, "Layer 1");
    bindFieldSelector(layerState2, "Layer 2");


    bindLayerToggle(layerState1, "Layer 1");
    bindLayerToggle(layerState2, "Layer 2");
    bindLayerToggle(layerState3, "Accessibility Layer");




    document.getElementById("loadBtn1").addEventListener("click", async function() {
      const file = document.getElementById("gpkgFile1").files[0];
      layerState1.file = file;
      if (!file) {
        setStatus(layerState1, "Please choose a .gpkg file first.");
        return;
      }
      await loadGeoPackageToState(file, layerState1, "Layer 1");
    });


    document.getElementById("loadBtn2").addEventListener("click", async function() {
      const file = document.getElementById("gpkgFile2").files[0];
      layerState2.file = file;
      if (!file) {
        setStatus(layerState2, "Please choose a .gpkg file first.");
        return;
      }
      await loadGeoPackageToState(file, layerState2, "Layer 2");
    });

    document.getElementById("loadExampleBtn").addEventListener("click", async function() {
      try {
        const [file1, file2] = await Promise.all([
          getFileFromUrl(DEFAULT_GPKG_Facility_LAYER, "facility_sample.gpkg"),
          getFileFromUrl(DEFAULT_GPKG_Population_LAYER, "population_sample.gpkg")
        ]);
        layerState1.file = file1;
        layerState2.file = file2;


        await Promise.all([
          loadGeoPackageToState(file2, layerState2, "Layer 2"),
          loadGeoPackageToState(file1, layerState1, "Layer 1")
        ]);

        // auto set both fields when example button is clicked
        setFieldIfExists(layerState2, "P1_001N");
        setFieldIfExists(layerState1, "Beds");
    
      } catch (err) {
        console.error(err);
      }
    });



    

  
    document.getElementById("loadBtn3").addEventListener("click", async function() {
      try {
        setStatus(layerState3, "Computing accessibility on backend...");



        const file_1 = layerState1.file;
        const file_2 = layerState2.file;

        if (!file_1 || !file_2) {
          setStatus(layerState3, "Please select both files before proceeding.");
          return;
        }

        const formData = new FormData();
        const field1 = layerState1.fieldSelectEl.value;
        const field2 = layerState2.fieldSelectEl.value;
        
        if (!field1 || !field2) {
          setStatus(layerState3, "Please select fields for both layers.");
          return;
        }


        formData.append("file_1", file_1);
        formData.append("file_2", file_2);
    
        formData.append("file_1_col", field1);
        formData.append("file_2_col", field2);

        formData.append("catchment_km", "10");
        formData.append("beta", "1.5");



        const response = await fetch("https://webgis.xuezhicang.com/api/measure_accessibility", {
          method: "POST",
          body: formData
        });

        

        if (!response.ok) {
          let msg = "Backend error";
          try {
            const err = await response.json();
            msg = err.error || msg;
          } catch {}
          throw new Error(msg);
        }

        const buffer = await response.arrayBuffer();


        const file = new File(
          [buffer],
          "accessibility.gpkg",
          { type: "application/geopackage+sqlite3" }
        );

        await loadGeoPackageToState(file, layerState3, "accesslibility Layer");


        // move accessibility legend/layer item to top of right panel
        moveAccessibilityToTop();
        updateLayerOrderFromPanel();


        // // optional: keep a downloadable file
        // const gpkgFile = new File([blob], "population_accessibility.gpkg", {
        //   type: "application/geopackage+sqlite3"
        // });

        // await loadReturnedGeoPackage(gpkgFile, layerState3);

        // setStatus(layerState3, "Accessibility layer loaded.");
      } catch (err) {
        console.error(err);
        // setStatus(layerState3, "Error: " + err.message);
      }
    });



function getClassLabel(val) {
  return {
    1: "Low",
    2: "Median-Low",
    3: "Median-High",
    4: "High"
  }[Number(val)] || val;
}

const container = document.getElementById("popup");
const content = document.getElementById("popup-content");
const closer = document.getElementById("popup-closer");

initLayerDragAndDrop();
updateLayerOrderFromPanel();


// IMPORTANT: use ol.Overlay if you are using the global OpenLayers build
const overlay = new ol.Overlay({
  element: container,
  autoPan: {
    animation: { duration: 250 }
  }
});

// IMPORTANT: actually add the overlay to the map
map.addOverlay(overlay);

closer.onclick = function () {
  overlay.setPosition(undefined);
  closer.blur();
  return false;
};

map.on("singleclick", function (evt) {
  let featureFound = false;

  map.forEachFeatureAtPixel(evt.pixel, function (feature, layer) {
    // only trigger for accessibility layer
    if (layer === layerState3.layer) {
      const class2sfca = feature.get("2sfca_class");
      const classGravity = feature.get("gravity_access_class");

      content.innerHTML = `
        <p><b>Accessibility Classes</b></p>
        <p>2SFCA: ${class2sfca} (${getClassLabel(class2sfca)})</p>
        <p>Gravity: ${classGravity} (${getClassLabel(classGravity)})</p>
      `;

      overlay.setPosition(evt.coordinate);
      featureFound = true;
      return true;
    }
  });

  if (!featureFound) {
    overlay.setPosition(undefined);
  }
});