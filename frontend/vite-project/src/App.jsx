import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as Plotly from "plotly.js-dist";

const SeismicViewer = () => {
  const [files, setFiles] = useState([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [fileMetadata, setFileMetadata] = useState([]);
  const [cubeInfo, setCubeInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sliceVisibility, setSliceVisibility] = useState({
    inline: true,
    xline: true,
    sample: true
  });
  const [sliceIndices, setSliceIndices] = useState({
    inline: 0,
    xline: 0,
    sample: 0
  });
  const [pendingSliceIndices, setPendingSliceIndices] = useState({
    inline: 0,
    xline: 0,
    sample: 0
  });
  const [sliceData, setSliceData] = useState({});
  const [isLoadingSlice, setIsLoadingSlice] = useState(false);
  const [compassRotation, setCompassRotation] = useState(0);
  const [backgroundColor, setBackgroundColor] = useState('white');
  const [colormap, setColormap] = useState('seismic');
  const [activeSubmenu, setActiveSubmenu] = useState(null);
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0 });
  const [minQuantile, setMinQuantile] = useState(0.01);
  const [maxQuantile, setMaxQuantile] = useState(0.99);
  const [showQuantilePanel, setShowQuantilePanel] = useState(false);
  const [vmin, setVmin] = useState(null);
  const [vmax, setVmax] = useState(null);
  const plotDiv = useRef(null);
  const debounceTimerRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const amplitudeInitialized = useRef(false);

  const API_BASE_URL = 'http://localhost:5000/api';

  const getColormapColors = (colormapName) => {
    let colors;
    switch (colormapName) {
      case 'classic-seismic': colors = ['#d62728', '#fff', '#1f77b4']; break;
      case 'grayscale': colors = ['#000', '#fff']; break;
      case 'rainbow': colors = ['purple', 'blue', 'green', 'yellow', 'orange', 'red']; break;
      case 'seismic': colors = ['#0000a0', '#0000ff', '#00ffff', '#ffffff', '#ffff00', '#ff0000', '#800000']; break;
      case 'blue-red': colors = ['#0000ff', '#ffffff', '#ff0000']; break;
      case 'spectrum': colors = ['#000080', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000', '#800000']; break;
      case 'hot': colors = ['#000080', '#0000ff', '#00ffff', '#ffffff', '#ffff00', '#ff0000', '#800000']; break;
      case 'geo': colors = ['#00487d', '#4cc3ff', '#a4dca4', '#f7f9bc', '#e1b400', '#a36a00', '#5f3600']; break;
      case 'jet': colors = ['#000080', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff7f00', '#ff0000', '#800000']; break;
      case 'petrel-diverging': colors = ['#2166ac', '#67a9cf', '#d1e5f0', '#ffffff', '#fddbc7', '#ef8a62', '#b2182b']; break;
      case 'red-white-navy(dark)': colors = ['#990706', '#c88881', '#ffffff', '#8185a6', '#1a1b55']; break;
      case 'red-white-blue(bright)': colors = ['#ff0101', '#ff6060', '#ffffff', '#8d8dff', '#0b0bff']; break;
      case 'contrast': colors = ['#000000', '#222222', '#838383', '#d6d6d6', '#ffffff']; break;
      case 'ant-track': colors = ['#ffffff', '#bebebe', '#646262', '#000000', '#00229c', '#00ebf6']; break;
      case 'local-flatness': colors = ['#a0feff', '#466fdb', '#282882', '#393969', '#c3c1bb', '#6a3e00', '#b90900', '#e69c00', '#f9e700']; break;
      case 'acoustic-impedance': colors = ['#cd9300', '#fcfa00', '#ff7b00', '#f50c00', '#6e9200', '#03fc1b', '#00ffe1', '#0047fd', '#0001ba', '#000039']; break;
      case 'seismics': colors = ['#c40900', '#ff5800', '#feca0b', '#ffffff', '#8991b1', '#546090', '#202849']; break;
      case 'extreme': colors = ['#000000', '#222222', '#838383', '#d6d6d6', '#ffffff', '#000000', '#222222', '#838383', '#d6d6d6', '#ffffff']; break;
      default: colors = ['#0000a0', '#0000ff', '#00ffff', '#ffffff', '#ffff00', '#ff0000', '#800000']; break;
    }

    // Convert colors array to Plotly colorscale format
    return colors.map((color, i) => [i / (colors.length - 1), color]);
  };

  const seismicColorscale = getColormapColors(colormap);

  const getAmplitudeRange = () => {
    if (!cubeInfo || !cubeInfo.amplitude_range) return { min: 0, max: 1 };

    if (vmin !== null && vmax !== null) {
      return { min: vmin, max: vmax };
    }

    const ampRange = cubeInfo.amplitude_range;

    const minVal = ampRange.display_min !== undefined ? ampRange.display_min :
      ampRange.actual_min !== undefined ? ampRange.actual_min :
        ampRange.min || 0;

    const maxVal = ampRange.display_max !== undefined ? ampRange.display_max :
      ampRange.actual_max !== undefined ? ampRange.actual_max :
        ampRange.max || 1;

    return { min: minVal, max: maxVal };
  };

  useEffect(() => {
    if (cubeInfo && cubeInfo.amplitude_range) {
      const ampRange = cubeInfo.amplitude_range;

      const baseMin = ampRange.display_min !== undefined ? ampRange.display_min : ampRange.min || 0;
      const baseMax = ampRange.display_max !== undefined ? ampRange.display_max : ampRange.max || 1;
      const range = baseMax - baseMin;

      if (!amplitudeInitialized.current) {
        setVmin(baseMin);
        setVmax(baseMax);
        amplitudeInitialized.current = true;
      } else {
        setVmin(baseMin + (range * minQuantile));
        setVmax(baseMin + (range * maxQuantile));
      }
    }
  }, [minQuantile, maxQuantile, cubeInfo]);

  const handleFileUpload = async (event) => {
    const selectedFiles = Array.from(event.target.files);
    setFiles(selectedFiles);
    setError(null);
    setLoading(true);

    amplitudeInitialized.current = false;
    setVmin(null);
    setVmax(null);

    const metadata = selectedFiles.map((file, index) => ({
      name: file.name,
      size: file.size,
      index: index
    }));
    setFileMetadata(metadata);
    setActiveFileIndex(0);

    const formData = new FormData();
    formData.append('files', selectedFiles[0]);

    try {
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }

      setCubeInfo(result.cube_info);

      const middleIndices = {
        inline: Math.floor(result.cube_info.shape[0] / 2),
        xline: Math.floor(result.cube_info.shape[1] / 2),
        sample: Math.floor(result.cube_info.shape[2] / 2)
      };
      setSliceIndices(middleIndices);
      setPendingSliceIndices(middleIndices);

      await loadSliceData(middleIndices);

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadSliceData = async (indices) => {
    const newSliceData = {};
    setIsLoadingSlice(true);

    try {
      for (const sliceType of ['inline', 'xline', 'sample']) {
        const response = await fetch(`${API_BASE_URL}/slice/${sliceType}/${indices[sliceType]}`);
        if (response.ok) {
          newSliceData[sliceType] = await response.json();
        }
      }

      setSliceData(newSliceData);
    } catch (err) {
      console.error('Failed to load slice data:', err);
    } finally {
      setIsLoadingSlice(false);
    }
  };

  const handleSliceChange = (sliceType, index) => {
    setPendingSliceIndices(prev => ({
      ...prev,
      [sliceType]: index
    }));


    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }


    debounceTimerRef.current = setTimeout(async () => {
      setSliceIndices(prev => ({
        ...prev,
        [sliceType]: index
      }));

      try {
        const response = await fetch(`${API_BASE_URL}/slice/${sliceType}/${index}`);
        if (response.ok) {
          const data = await response.json();
          setSliceData(prev => ({
            ...prev,
            [sliceType]: data
          }));
        }
      } catch (err) {
        console.error(`Failed to load ${sliceType} slice:`, err);
      }
    }, 150);
  };

  const handleVisibilityChange = (sliceType) => {
    setSliceVisibility(prev => ({
      ...prev,
      [sliceType]: !prev[sliceType]
    }));
  };

  const handleBackgroundChange = (color) => {
    setBackgroundColor(color);
  };

  const handleFileSwitch = async (fileIndex) => {
    if (fileIndex === activeFileIndex || fileIndex >= files.length) return;

    setActiveFileIndex(fileIndex);
    setLoading(true);
    setError(null);

    amplitudeInitialized.current = false;
    setVmin(null);
    setVmax(null);

    const formData = new FormData();
    formData.append('files', files[fileIndex]);

    try {
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }

      setCubeInfo(result.cube_info);

      const middleIndices = {
        inline: Math.floor(result.cube_info.shape[0] / 2),
        xline: Math.floor(result.cube_info.shape[1] / 2),
        sample: Math.floor(result.cube_info.shape[2] / 2)
      };
      setSliceIndices(middleIndices);
      setPendingSliceIndices(middleIndices);

      await loadSliceData(middleIndices);

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateCompass = useCallback(() => {
    if (plotDiv.current && plotDiv.current.layout && plotDiv.current.layout.scene) {
      const camera = plotDiv.current.layout.scene.camera;
      if (camera && camera.eye) {
        const cameraAzimuth = Math.atan2(camera.eye.y, camera.eye.x) * (180 / Math.PI);

        const compassAngle = -cameraAzimuth + 45;

        setCompassRotation(compassAngle);
      }
    }
  }, []);

  const create3DVisualization = useCallback(() => {
    if (!cubeInfo || !sliceData || Object.keys(sliceData).length === 0) {
      return;
    }

    const traces = [];
    const ampRange = getAmplitudeRange();

    const cubeOutlineTraces = createCubeOutline();
    traces.push(...cubeOutlineTraces);

    if (sliceVisibility.inline && sliceData.inline) {
      const inlineTrace = createInlineSlice(ampRange);
      if (inlineTrace) traces.push(inlineTrace);
    }

    if (sliceVisibility.xline && sliceData.xline) {
      const xlineTrace = createXlineSlice(ampRange);
      if (xlineTrace) traces.push(xlineTrace);
    }

    if (sliceVisibility.sample && sliceData.sample) {
      const sampleTrace = createSampleSlice(ampRange);
      if (sampleTrace) traces.push(sampleTrace);
    }

    const layout = {
      title: {
        text: `<b>3D Seismic Cube Visualization</b><br>` +
          `<sub>INLINE: ${cubeInfo.inline_range.min + sliceIndices.inline} | ` +
          `XLINE: ${cubeInfo.xline_range.min + sliceIndices.xline} | ` +
          `Sample: ${(cubeInfo.sample_range.min + sliceIndices.sample * (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1)).toFixed(1)}</sub>`,
        x: 0.5,
        font: { size: 16, color: backgroundColor === 'black' ? '#ffffff' : '#000000' }
      },
      scene: {
        xaxis: {
          title: {
            text: '',
            font: { size: 18, color: backgroundColor === 'black' ? '#ffffff' : '#000000', family: 'Arial Black, sans-serif' }
          },
          backgroundcolor: backgroundColor === 'black' ? "#000000" : "#ffffff",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [
            cubeInfo.xline_range.min - (cubeInfo.xline_range.max - cubeInfo.xline_range.min) * 0.05,
            cubeInfo.xline_range.max + (cubeInfo.xline_range.max - cubeInfo.xline_range.min) * 0.15
          ]
        },
        yaxis: {
          title: {
            text: '',
            font: { size: 18, color: backgroundColor === 'black' ? '#ffffff' : '#000000', family: 'Arial Black, sans-serif' }
          },
          backgroundcolor: backgroundColor === 'black' ? "#000000" : "#ffffff",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [
            cubeInfo.inline_range.min - (cubeInfo.inline_range.max - cubeInfo.inline_range.min) * 0.05,
            cubeInfo.inline_range.max + (cubeInfo.inline_range.max - cubeInfo.inline_range.min) * 0.20
          ]
        },
        zaxis: {
          title: {
            text: '',
            font: { size: 18, color: backgroundColor === 'black' ? '#ffffff' : '#000000', family: 'Arial Black, sans-serif' }
          },
          backgroundcolor: backgroundColor === 'black' ? "#000000" : "#ffffff",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [cubeInfo.sample_range.max, cubeInfo.sample_range.min],
          autorange: 'reversed'
        },
        bgcolor: backgroundColor === 'black' ? "#000000" : "#ffffff",
        camera: {
          eye: { x: 1.6, y: 1.6, z: 1.4 },
          center: { x: 0, y: 0, z: 0 }
        },
        aspectmode: 'manual',
        aspectratio: {
          x: 1.1,
          y: 1.1,
          z: 0.8
        }
      },
      autosize: true,
      margin: { r: 50, b: 10, l: 10, t: 60 },
      dragmode: 'orbit',
      showlegend: false,
      paper_bgcolor: backgroundColor === 'black' ? '#000000' : '#ffffff',
      plot_bgcolor: backgroundColor === 'black' ? '#000000' : '#ffffff'
    };

    // Preserve current camera position if plot already exists
    if (plotDiv.current && plotDiv.current.layout && plotDiv.current.layout.scene && plotDiv.current.layout.scene.camera) {
      layout.scene.camera = plotDiv.current.layout.scene.camera;
    }


    if (plotDiv.current) {
      Plotly.newPlot(plotDiv.current, traces, layout, {
        displayModeBar: true,
        modeBarButtonsToRemove: ['pan2d', 'select2d', 'lasso2d', 'resetCameraDefault3d', 'resetCameraLastSave3d'],
        modeBarButtonsToAdd: [{
          name: 'Reset camera',
          icon: Plotly.Icons.home,
          click: function (gd) {
            Plotly.relayout(gd, {
              'scene.camera': {
                eye: { x: 1.6, y: 1.6, z: 1.4 },
                center: { x: 0, y: 0, z: 0 },
                up: { x: 0, y: 0, z: 1 }
              }
            });
          }
        }],
        responsive: true
      }).then(() => {

        updateCompass();


        plotDiv.current.on('plotly_relayout', (eventData) => {
          setTimeout(updateCompass, 100);
        });

        plotDiv.current.on('plotly_animated', () => {
          setTimeout(updateCompass, 100);
        });

        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }

        pollIntervalRef.current = setInterval(() => {
          if (plotDiv.current && plotDiv.current.layout && plotDiv.current.layout.scene) {
            const camera = plotDiv.current.layout.scene.camera;
            if (camera && camera.eye) {
              const cameraAzimuth = Math.atan2(camera.eye.y, camera.eye.x) * (180 / Math.PI);
              const expectedCompassAngle = -cameraAzimuth + 45;

              if (Math.abs(expectedCompassAngle - compassRotation) > 0.1) {
                updateCompass();
              }
            }
          }
        }, 50);
      });
    }
  }, [cubeInfo, sliceData, sliceVisibility, sliceIndices, backgroundColor, colormap, updateCompass, vmin, vmax]);

  const createCubeOutline = () => {
    if (!cubeInfo) return [];

    const { inline_range, xline_range, sample_range } = cubeInfo;

    const vertices = [
      [xline_range.min, inline_range.min, sample_range.min],
      [xline_range.max, inline_range.min, sample_range.min],
      [xline_range.max, inline_range.max, sample_range.min],
      [xline_range.min, inline_range.max, sample_range.min],
      [xline_range.min, inline_range.min, sample_range.max],
      [xline_range.max, inline_range.min, sample_range.max],
      [xline_range.max, inline_range.max, sample_range.max],
      [xline_range.min, inline_range.max, sample_range.max]
    ];

    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    return edges.map((edge, index) => {
      const start = vertices[edge[0]];
      const end = vertices[edge[1]];
      return {
        type: 'scatter3d',
        x: [start[0], end[0], null],
        y: [start[1], end[1], null],
        z: [start[2], end[2], null],
        mode: 'lines',
        line: { color: backgroundColor === 'black' ? 'rgba(200,200,200,0.8)' : 'rgba(100,100,100,0.8)', width: 4 },
        showlegend: false,
        hoverinfo: 'skip',
        name: `outline_${index}`
      };
    });
  };

  const createInlineSlice = (ampRange) => {
    const data = sliceData.inline;
    if (!data || !cubeInfo || !data.data || !data.coordinates) return null;

    const inlineVal = cubeInfo.inline_range.min + sliceIndices.inline;
    const fileName = files.length > 0 ? files[0].name.replace(/\.[^/.]+$/, '') : 'Seismic Data';
    let sliceMatrix = data.data;
    if (!Array.isArray(sliceMatrix[0])) {
      console.error('Slice data is not 2D array!');
      return null;
    }

    const xlineCoords = data.coordinates.x;
    const sampleCoords = data.coordinates.y;

    if (sliceMatrix.length === xlineCoords.length && sliceMatrix[0].length === sampleCoords.length) {
      sliceMatrix = sliceMatrix[0].map((_, colIndex) => sliceMatrix.map(row => row[colIndex]));
    }

    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    const hoverText = [];

    for (let i = 0; i < sampleCoords.length; i++) {
      const xRow = [];
      const yRow = [];
      const zRow = [];
      const textRow = [];

      for (let j = 0; j < xlineCoords.length; j++) {
        xRow.push(xlineCoords[j]);
        yRow.push(inlineVal);
        zRow.push(sampleCoords[i]);

        let amplitude = -0.999;
        if (sliceMatrix[i] && sliceMatrix[i][j] !== undefined && sliceMatrix[i][j] !== null) {
          amplitude = Number(sliceMatrix[i][j]);
        }

        const hoverString = `${fileName}<br>Inline: ${inlineVal}<br>XLINE: ${xlineCoords[j]}<br>Sample: ${sampleCoords[i].toFixed(2)}<br>Amplitude: ${amplitude.toFixed(6)}`;
        textRow.push(hoverString);
      }

      xMesh.push(xRow);
      yMesh.push(yRow);
      zMesh.push(zRow);
      hoverText.push(textRow);
    }

    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      text: hoverText,
      hoverinfo: 'text',
      colorscale: seismicColorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `INLINE ${inlineVal}`,
      showscale: false,
      opacity: 0.9,
      contours: {
        x: { highlight: false },
        y: { highlight: false },
        z: { highlight: false }
      },
      lighting: {
        ambient: 0.8,
        diffuse: 0.8,
        fresnel: 0.2,
        specular: 0.1,
        roughness: 0.8
      },
      hoverlabel: {
        bgcolor: 'rgba(255,255,255,0.9)',
        bordercolor: '#333',
        font: { size: 12, color: '#333', family: 'Arial, sans-serif' }
      }
    };
  };

  const createXlineSlice = (ampRange) => {
    const data = sliceData.xline;
    if (!data || !cubeInfo || !data.data || !data.coordinates) return null;

    const xlineVal = cubeInfo.xline_range.min + sliceIndices.xline;
    const fileName = files.length > 0 ? files[0].name.replace(/\.[^/.]+$/, '') : 'Seismic Data';
    let sliceMatrix = data.data;
    if (!Array.isArray(sliceMatrix[0])) {
      console.error('Slice data is not 2D array!');
      return null;
    }

    const inlineCoords = data.coordinates.x;
    const sampleCoords = data.coordinates.y;

    if (sliceMatrix.length === inlineCoords.length && sliceMatrix[0].length === sampleCoords.length) {
      sliceMatrix = sliceMatrix[0].map((_, colIndex) => sliceMatrix.map(row => row[colIndex]));
    }

    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    const hoverText = [];

    for (let i = 0; i < sampleCoords.length; i++) {
      const xRow = [];
      const yRow = [];
      const zRow = [];
      const textRow = [];

      for (let j = 0; j < inlineCoords.length; j++) {
        xRow.push(xlineVal);
        yRow.push(inlineCoords[j]);
        zRow.push(sampleCoords[i]);

        let amplitude = -0.999;
        if (sliceMatrix[i] && sliceMatrix[i][j] !== undefined && sliceMatrix[i][j] !== null) {
          amplitude = Number(sliceMatrix[i][j]);
        }

        const hoverString = `${fileName}<br>Inline: ${inlineCoords[j]}<br>XLINE: ${xlineVal}<br>Sample: ${sampleCoords[i].toFixed(2)}<br>Amplitude: ${amplitude.toFixed(6)}`;
        textRow.push(hoverString);
      }

      xMesh.push(xRow);
      yMesh.push(yRow);
      zMesh.push(zRow);
      hoverText.push(textRow);
    }

    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      text: hoverText,
      hoverinfo: 'text',
      colorscale: seismicColorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `XLINE ${xlineVal}`,
      showscale: false,
      opacity: 0.9,
      contours: {
        x: { highlight: false },
        y: { highlight: false },
        z: { highlight: false }
      },
      lighting: {
        ambient: 0.8,
        diffuse: 0.8,
        fresnel: 0.2,
        specular: 0.1,
        roughness: 0.8
      },
      hoverlabel: {
        bgcolor: 'rgba(255,255,255,0.9)',
        bordercolor: '#333',
        font: { size: 12, color: '#333', family: 'Arial, sans-serif' }
      }
    };
  };

  const createSampleSlice = (ampRange) => {
    const data = sliceData.sample;
    if (!data || !cubeInfo || !data.data || !data.coordinates) return null;

    const sampleVal = cubeInfo.sample_range.min + sliceIndices.sample *
      (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1);
    const fileName = files.length > 0 ? files[0].name.replace(/\.[^/.]+$/, '') : 'Seismic Data';

    let sliceMatrix = data.data;
    if (!Array.isArray(sliceMatrix[0])) {
      console.error('Slice data is not 2D array!');
      return null;
    }

    const inlineCoords = data.coordinates.x;
    const xlineCoords = data.coordinates.y;

    if (sliceMatrix.length === xlineCoords.length && sliceMatrix[0].length === inlineCoords.length) {
      sliceMatrix = sliceMatrix[0].map((_, colIndex) => sliceMatrix.map(row => row[colIndex]));
    }

    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    const hoverText = [];

    for (let i = 0; i < inlineCoords.length; i++) {
      const xRow = [];
      const yRow = [];
      const zRow = [];
      const textRow = [];

      for (let j = 0; j < xlineCoords.length; j++) {
        xRow.push(xlineCoords[j]);
        yRow.push(inlineCoords[i]);
        zRow.push(sampleVal);

        let amplitude = -0.999;
        if (sliceMatrix[i] && sliceMatrix[i][j] !== undefined && sliceMatrix[i][j] !== null) {
          amplitude = Number(sliceMatrix[i][j]);
        }

        const hoverString = `${fileName}<br>Inline: ${inlineCoords[i]}<br>XLINE: ${xlineCoords[j]}<br>Sample: ${sampleVal.toFixed(2)}<br>Amplitude: ${amplitude.toFixed(6)}`;
        textRow.push(hoverString);
      }

      xMesh.push(xRow);
      yMesh.push(yRow);
      zMesh.push(zRow);
      hoverText.push(textRow);
    }

    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      text: hoverText,
      hoverinfo: 'text',
      colorscale: seismicColorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `Sample ${sampleVal.toFixed(1)}`,
      showscale: true,
      opacity: 0.9,
      contours: {
        x: { highlight: false },
        y: { highlight: false },
        z: { highlight: false }
      },
      lighting: {
        ambient: 0.8,
        diffuse: 0.8,
        fresnel: 0.2,
        specular: 0.1,
        roughness: 0.8
      },
      colorbar: {
        title: "Seismic Amplitude",
        titleside: "right",
        tickmode: "linear",
        tick0: ampRange.min,
        dtick: (ampRange.max - ampRange.min) / 8,
        len: 0.5,
        thickness: 20,
        x: 1.02,
        bgcolor: "rgba(255,255,255,0.8)",
        bordercolor: "rgba(0,0,0,0.2)",
        borderwidth: 1
      },
      hoverlabel: {
        bgcolor: 'rgba(255,255,255,0.9)',
        bordercolor: '#333',
        font: { size: 12, color: '#333', family: 'Arial, sans-serif' }
      }
    };
  };

  useEffect(() => {
    create3DVisualization();
  }, [create3DVisualization]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', width: '100%', margin: '0 auto', padding: '20px', boxSizing: 'border-box' }}>
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
      </div>

      <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
        <div style={{ marginBottom: '15px' }}>
          <input
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            accept=".segy,.sgy,.zip"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            id="file-upload"
          />
          <label
            htmlFor="file-upload"
            style={{
              backgroundColor: '#3498db',
              color: 'white',
              padding: '12px 24px',
              borderRadius: '6px',
              cursor: 'pointer',
              border: 'none',
              fontSize: '16px',
              display: 'inline-block',
              transition: 'background-color 0.3s'
            }}
            onMouseOver={e => e.target.style.backgroundColor = '#2980b9'}
            onMouseOut={e => e.target.style.backgroundColor = '#3498db'}
          >
            Choose Folder
          </label>
        </div>

        {files.length > 0 && (
          <div>
            <h3 style={{ marginBottom: '10px', color: '#2c3e50' }}>Selected Files:</h3>
            <ul style={{ margin: 0, paddingLeft: '20px' }}>
              {files.map((file, index) => (
                <li key={index} style={{ marginBottom: '5px', color: '#34495e' }}>
                  {file.name} ({(file.size / (1024 * 1024)).toFixed(2)} MB)
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{
            border: '4px solid #f3f3f3',
            borderTop: '4px solid #3498db',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 20px'
          }}></div>
          <p style={{ color: '#7f8c8d' }}>Processing seismic data...</p>
        </div>
      )}

      {error && (
        <div style={{
          backgroundColor: '#e74c3c',
          color: 'white',
          padding: '15px',
          borderRadius: '6px',
          marginBottom: '20px'
        }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {cubeInfo && !loading && (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{
            backgroundColor: '#f8f9fa',
            padding: '35px',
            borderRadius: '8px',
            width: '25%',
            flexShrink: 0,
            minWidth: '300px',
            maxWidth: '500px'
          }}>
            <h3 style={{ color: '#2c3e50', marginBottom: '20px', fontSize: '28px', fontWeight: 'bold' }}>Control Panel</h3>

            <div style={{ marginBottom: '25px' }}>
              <h4 style={{ color: '#34495e', marginBottom: '15px', fontSize: '22px', fontWeight: '600' }}>Navigation</h4>
              <div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', fontSize: '19px' }}>
                    INLINE: {cubeInfo.inline_range.min + pendingSliceIndices.inline}
                    {pendingSliceIndices.inline !== sliceIndices.inline && <span style={{ marginLeft: '8px', fontSize: '16px', color: '#3498db' }}>Loading...</span>}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[0] - 1}
                    value={pendingSliceIndices.inline}
                    onChange={(e) => handleSliceChange('inline', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', fontSize: '19px' }}>
                    XLINE: {cubeInfo.xline_range.min + pendingSliceIndices.xline}
                    {pendingSliceIndices.xline !== sliceIndices.xline && <span style={{ marginLeft: '8px', fontSize: '16px', color: '#3498db' }}>Loading...</span>}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[1] - 1}
                    value={pendingSliceIndices.xline}
                    onChange={(e) => handleSliceChange('xline', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', fontSize: '19px' }}>
                    Sample: {(cubeInfo.sample_range.min + pendingSliceIndices.sample * (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1)).toFixed(1)}
                    {pendingSliceIndices.sample !== sliceIndices.sample && <span style={{ marginLeft: '8px', fontSize: '16px', color: '#3498db' }}>Loading...</span>}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[2] - 1}
                    value={pendingSliceIndices.sample}
                    onChange={(e) => handleSliceChange('sample', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ color: '#34495e', marginBottom: '15px', fontSize: '22px', fontWeight: '600' }}>Slice Visibility</h4>
              <div>
                <label style={{ display: 'block', marginBottom: '10px', fontSize: '18px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.inline}
                    onChange={() => handleVisibilityChange('inline')}
                    style={{ marginRight: '10px' }}
                  />
                  INLINE Slice
                </label>
                <label style={{ display: 'block', marginBottom: '10px', fontSize: '18px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.xline}
                    onChange={() => handleVisibilityChange('xline')}
                    style={{ marginRight: '10px' }}
                  />
                  XLINE Slice
                </label>
                <label style={{ display: 'block', marginBottom: '10px', fontSize: '18px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.sample}
                    onChange={() => handleVisibilityChange('sample')}
                    style={{ marginRight: '10px' }}
                  />
                  Sample Slice
                </label>
              </div>
            </div>


            {cubeInfo && cubeInfo.amplitude_range && (
              <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#e8f4f8', borderRadius: '6px' }}>
                <h4 style={{ color: '#2c3e50', margin: '0 0 10px 0', fontSize: '22px', fontWeight: '600' }}>Amplitude Statistics</h4>

                {/* Amplitude Range Control Button */}
                <button
                  onClick={() => setShowQuantilePanel(!showQuantilePanel)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    backgroundColor: 'white',
                    borderRadius: '6px',
                    border: '1px solid #ccc',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    fontSize: '17px',
                    fontWeight: '500',
                    color: '#2c3e50',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    justifyContent: 'center'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'white'}
                >
                  <svg style={{ width: '16px', height: '16px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                  Amplitude Range Control
                </button>

                {/* Quantile Control Panel */}
                {showQuantilePanel && (
                  <div style={{ marginTop: '12px', padding: '12px', backgroundColor: 'white', borderRadius: '6px', border: '1px solid #ddd' }}>
                    {/* Min Quantile */}
                    <div style={{ marginBottom: '15px' }}>
                      <label style={{ fontSize: '15px', fontWeight: '600', color: '#555', marginBottom: '6px', display: 'block' }}>
                        Min Quantile (Lower Clip)
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="range"
                          value={minQuantile}
                          onChange={(e) => setMinQuantile(parseFloat(e.target.value))}
                          step="0.01"
                          min="0"
                          max="0.5"
                          style={{ flex: 1 }}
                        />
                        <input
                          type="number"
                          value={minQuantile}
                          onChange={(e) => setMinQuantile(parseFloat(e.target.value))}
                          step="0.01"
                          min="0"
                          max="0.5"
                          style={{ width: '60px', padding: '4px 6px', fontSize: '14px', border: '1px solid #ccc', borderRadius: '4px' }}
                        />
                      </div>
                    </div>

                    {/* Max Quantile */}
                    <div style={{ marginBottom: '15px' }}>
                      <label style={{ fontSize: '15px', fontWeight: '600', color: '#555', marginBottom: '6px', display: 'block' }}>
                        Max Quantile (Upper Clip)
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="range"
                          value={maxQuantile}
                          onChange={(e) => setMaxQuantile(parseFloat(e.target.value))}
                          step="0.01"
                          min="0.5"
                          max="1"
                          style={{ flex: 1 }}
                        />
                        <input
                          type="number"
                          value={maxQuantile}
                          onChange={(e) => setMaxQuantile(parseFloat(e.target.value))}
                          step="0.01"
                          min="0.5"
                          max="1"
                          style={{ width: '60px', padding: '4px 6px', fontSize: '14px', border: '1px solid #ccc', borderRadius: '4px' }}
                        />
                      </div>
                    </div>

                    {/* Current Values Display */}
                    {vmin !== null && vmax !== null && (
                      <div style={{ paddingTop: '12px', borderTop: '1px solid #e0e0e0', marginTop: '8px' }}>
                        <div style={{ fontSize: '14px', color: '#555' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span>Current Min:</span>
                            <span style={{ fontFamily: 'monospace', fontWeight: '600', color: '#2c3e50' }}>{vmin.toFixed(4)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span>Current Max:</span>
                            <span style={{ fontFamily: 'monospace', fontWeight: '600', color: '#2c3e50' }}>{vmax.toFixed(4)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Range:</span>
                            <span style={{ fontFamily: 'monospace', fontWeight: '600', color: '#2c3e50' }}>{(vmax - vmin).toFixed(4)}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Quick Presets */}
                    <div style={{ paddingTop: '12px', borderTop: '1px solid #e0e0e0', marginTop: '12px' }}>
                      <label style={{ fontSize: '15px', fontWeight: '600', color: '#555', marginBottom: '8px', display: 'block' }}>Quick Presets:</label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                        <button
                          onClick={() => {
                            setMinQuantile(0.0);
                            setMaxQuantile(1.0);
                          }}
                          style={{
                            padding: '6px 8px',
                            fontSize: '14px',
                            backgroundColor: '#f0f0f0',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                          }}
                          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#e0e0e0'}
                          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                        >
                          Full (0-1)
                        </button>
                        <button
                          onClick={() => {
                            setMinQuantile(0.01);
                            setMaxQuantile(0.99);
                          }}
                          style={{
                            padding: '6px 8px',
                            fontSize: '14px',
                            backgroundColor: '#cce5ff',
                            color: '#004085',
                            border: '1px solid #b3d9ff',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                          }}
                          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#b3d9ff'}
                          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#cce5ff'}
                        >
                          Default
                        </button>
                        <button
                          onClick={() => {
                            setMinQuantile(0.05);
                            setMaxQuantile(0.95);
                          }}
                          style={{
                            padding: '6px 8px',
                            fontSize: '14px',
                            backgroundColor: '#f0f0f0',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                          }}
                          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#e0e0e0'}
                          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                        >
                          5-95%
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, position: 'relative', width: '100%' }}>
            <div
              ref={plotDiv}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  visible: true,
                  x: e.clientX,
                  y: e.clientY
                });
              }}
              onClick={() => setContextMenu({ visible: false, x: 0, y: 0 })}
              style={{
                width: '100%',
                height: '80vh',
                minHeight: '500px',
                maxHeight: '900px',
                border: '1px solid #ddd',
                borderRadius: '8px',
                backgroundColor: backgroundColor === 'black' ? '#000000' : 'white'
              }}
            />

            <div style={{
              position: 'absolute',
              top: '80px',
              right: '500px',
              width: '80px',
              height: '80px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              pointerEvents: 'none'
            }}>
              <div style={{
                position: 'relative',
                width: '100%',
                height: '100%'
              }}>
                <svg width="80" height="80" style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `rotate(${compassRotation}deg)`,
                  transition: 'transform 0.3s ease'
                }}>

                  <path d="M 40 10 L 35 30 L 40 25 L 45 30 Z" fill="#FF0000" stroke="#CC0000" strokeWidth="1" />

                  <circle cx="40" cy="40" r="3" fill="#333" />
                </svg>

                <div style={{
                  position: 'absolute',
                  top: '-8px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  color: '#FF0000',
                  fontFamily: 'Arial, sans-serif'
                }}>
                  N
                </div>
              </div>
            </div>

            <div style={{
              backgroundColor: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              marginTop: '20px'
            }}>
              <h3 style={{ color: '#2c3e50', marginBottom: '15px' }}>Data Information</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '15px' }}>
                <div>
                  <strong>Cube Dimensions:</strong> {cubeInfo.shape.join(' × ')}
                </div>
                <div>
                  <strong>INLINE Range:</strong> {cubeInfo.inline_range.min} to {cubeInfo.inline_range.max} ({cubeInfo.inline_range.count} lines)
                </div>
                <div>
                  <strong>XLINE Range:</strong> {cubeInfo.xline_range.min} to {cubeInfo.xline_range.max} ({cubeInfo.xline_range.count} lines)
                </div>
                <div>
                  <strong>Sample Range:</strong> {cubeInfo.sample_range.min.toFixed(1)} to {cubeInfo.sample_range.max.toFixed(1)} ({cubeInfo.sample_range.count} samples)
                </div>
                <div>
                  <strong>Memory Usage:</strong> {cubeInfo.memory_usage_mb.toFixed(1)} MB
                </div>
              </div>

              <div style={{ marginTop: '15px', padding: '15px', backgroundColor: '#e8f4f8', borderRadius: '6px' }}>
                <h4 style={{ color: '#2c3e50', margin: '0 0 10px 0' }}>Current Position</h4>
                <p style={{ margin: 0, color: '#34495e' }}>
                  INLINE: {cubeInfo.inline_range.min + sliceIndices.inline} |
                  XLINE: {cubeInfo.xline_range.min + sliceIndices.xline} |
                  Sample: {(cubeInfo.sample_range.min + sliceIndices.sample * (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1)).toFixed(2)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        input[type="range"] {
          -webkit-appearance: none;
          width: 100%;
          height: 6px;
          border-radius: 3px;
          background: #ddd;
          outline: none;
        }

        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #3498db;
          cursor: pointer;
        }

        input[type="range"]::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #3498db;
          cursor: pointer;
          border: none;
        }
      `}</style>

      {/* Custom Context Menu Popup */}
      {contextMenu.visible && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: '#ffffff',
            border: '1px solid #ccc',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 9999,
            minWidth: '180px',
            overflow: 'visible',
            fontFamily: 'Arial, sans-serif'
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setActiveSubmenu(null)}
        >
          {/* Background Parent Menu Item */}
          <div
            style={{
              padding: '12px 16px',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
              fontSize: '14px',
              color: '#333',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              position: 'relative',
              backgroundColor: activeSubmenu === 'background' ? '#f0f0f0' : 'transparent'
            }}
            onMouseEnter={() => setActiveSubmenu('background')}
          >
            <span>Background</span>
            <span style={{ marginLeft: '10px', fontSize: '12px' }}>▶</span>

            {/* Background Submenu */}
            {activeSubmenu === 'background' && (
              <div
                style={{
                  position: 'absolute',
                  top: '-1px',
                  left: 'calc(100% - 1px)',
                  backgroundColor: '#ffffff',
                  border: '1px solid #ccc',
                  borderRadius: '8px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  minWidth: '160px',
                  overflow: 'hidden',
                  zIndex: 10000
                }}
                onMouseEnter={() => setActiveSubmenu('background')}
              >
                <div
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    fontSize: '14px',
                    color: '#333',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  onClick={() => {
                    setBackgroundColor('white');
                    setContextMenu({ visible: false, x: 0, y: 0 });
                    setActiveSubmenu(null);
                  }}
                >
                  <div style={{ width: '20px', height: '20px', backgroundColor: '#ffffff', border: '1px solid #ccc', borderRadius: '3px' }}></div>
                  White
                </div>
                <div
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    fontSize: '14px',
                    color: '#333',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  onClick={() => {
                    setBackgroundColor('black');
                    setContextMenu({ visible: false, x: 0, y: 0 });
                    setActiveSubmenu(null);
                  }}
                >
                  <div style={{ width: '20px', height: '20px', backgroundColor: '#000000', border: '1px solid #ccc', borderRadius: '3px' }}></div>
                  Black
                </div>
              </div>
            )}
          </div>

          {/* Seismic Parent Menu Item */}
          {fileMetadata.length > 0 && (
            <div
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
                fontSize: '14px',
                color: '#333',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                position: 'relative',
                borderTop: '1px solid #eee',
                backgroundColor: activeSubmenu === 'seismic' ? '#f0f0f0' : 'transparent'
              }}
              onMouseEnter={() => setActiveSubmenu('seismic')}
            >
              <span>Seismic</span>
              <span style={{ marginLeft: '10px', fontSize: '12px' }}>▶</span>

              {/* Seismic Submenu */}
              {activeSubmenu === 'seismic' && (
                <div
                  style={{
                    position: 'absolute',
                    top: '-1px',
                    left: 'calc(100% - 1px)',
                    backgroundColor: '#ffffff',
                    border: '1px solid #ccc',
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '250px',
                    maxHeight: '400px',
                    overflowY: 'auto',
                    zIndex: 10000
                  }}
                  onMouseEnter={() => setActiveSubmenu('seismic')}
                >
                  {fileMetadata.map((file) => (
                    <div
                      key={file.index}
                      style={{
                        padding: '10px 16px',
                        cursor: 'pointer',
                        transition: 'background-color 0.2s',
                        fontSize: '14px',
                        color: '#333',
                        backgroundColor: activeFileIndex === file.index ? '#e3f2fd' : 'transparent',
                        fontWeight: activeFileIndex === file.index ? 'bold' : 'normal'
                      }}
                      onMouseEnter={(e) => {
                        if (activeFileIndex !== file.index) {
                          e.currentTarget.style.backgroundColor = '#f0f0f0';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (activeFileIndex !== file.index) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }
                      }}
                      onClick={() => {
                        handleFileSwitch(file.index);
                        setContextMenu({ visible: false, x: 0, y: 0 });
                        setActiveSubmenu(null);
                      }}
                    >
                      <div>{file.name.replace(/\.[^/.]+$/, '')}</div>
                      <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>
                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                      </div>
                      {activeFileIndex === file.index && <span style={{ marginLeft: '8px', color: '#1976d2' }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Colormap Parent Menu Item */}
          <div
            style={{
              padding: '12px 16px',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
              fontSize: '14px',
              color: '#333',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              position: 'relative',
              borderTop: '1px solid #eee',
              backgroundColor: activeSubmenu === 'colormap' ? '#f0f0f0' : 'transparent'
            }}
            onMouseEnter={() => setActiveSubmenu('colormap')}
          >
            <span>Colormap</span>
            <span style={{ marginLeft: '10px', fontSize: '12px' }}>▶</span>

            {/* Colormap Submenu */}
            {activeSubmenu === 'colormap' && (
              <div
                style={{
                  position: 'absolute',
                  top: '-1px',
                  left: 'calc(100% - 1px)',
                  backgroundColor: '#ffffff',
                  border: '1px solid #ccc',
                  borderRadius: '8px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  minWidth: '200px',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  zIndex: 10000
                }}
                onMouseEnter={() => setActiveSubmenu('colormap')}
              >
                {[
                  { value: 'seismic', label: 'Seismic' },
                  { value: 'classic-seismic', label: 'Classic Seismic' },
                  { value: 'grayscale', label: 'Grayscale' },
                  { value: 'rainbow', label: 'Rainbow' },
                  { value: 'blue-red', label: 'Blue-Red' },
                  { value: 'spectrum', label: 'Spectrum' },
                  { value: 'hot', label: 'Hot' },
                  { value: 'geo', label: 'Geo' },
                  { value: 'jet', label: 'Jet' },
                  { value: 'petrel-diverging', label: 'Petrel Diverging' },
                  { value: 'red-white-navy(dark)', label: 'Red-White-Navy (Dark)' },
                  { value: 'red-white-blue(bright)', label: 'Red-White-Blue (Bright)' },
                  { value: 'contrast', label: 'Contrast' },
                  { value: 'ant-track', label: 'Ant Track' },
                  { value: 'local-flatness', label: 'Local Flatness' },
                  { value: 'acoustic-impedance', label: 'Acoustic Impedance' },
                  { value: 'seismics', label: 'Seismics' },
                  { value: 'extreme', label: 'Extreme' }
                ].map((option) => (
                  <div
                    key={option.value}
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      transition: 'background-color 0.2s',
                      fontSize: '14px',
                      color: '#333',
                      backgroundColor: colormap === option.value ? '#e3f2fd' : 'transparent',
                      fontWeight: colormap === option.value ? 'bold' : 'normal'
                    }}
                    onMouseEnter={(e) => {
                      if (colormap !== option.value) {
                        e.currentTarget.style.backgroundColor = '#f0f0f0';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (colormap !== option.value) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                    onClick={() => {
                      setColormap(option.value);
                      setContextMenu({ visible: false, x: 0, y: 0 });
                      setActiveSubmenu(null);
                    }}
                  >
                    {option.label}
                    {colormap === option.value && <span style={{ marginLeft: '8px', color: '#1976d2' }}>✓</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SeismicViewer;