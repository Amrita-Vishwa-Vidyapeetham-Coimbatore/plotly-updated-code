import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as Plotly from "plotly.js-dist";

const SeismicViewer = () => {
  const [files, setFiles] = useState([]);
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
  const plotDiv = useRef(null);
  const debounceTimerRef = useRef(null);
  const pollIntervalRef = useRef(null);

  const API_BASE_URL = 'http://localhost:5000/api';

  const seismicColorscale = [
    [0.0, '#000080'],
    [0.15, '#0066CC'],
    [0.3, '#00AAFF'],
    [0.4, '#66DDFF'],
    [0.45, '#CCFFFF'],
    [0.5, '#FFFFFF'],
    [0.55, '#FFFFCC'],
    [0.6, '#FFDD66'],
    [0.7, '#FFAA00'],
    [0.85, '#FF6600'],
    [1.0, '#CC0000']
  ];

  const getAmplitudeRange = () => {
    if (!cubeInfo || !cubeInfo.amplitude_range) return { min: 0, max: 1 };

    const ampRange = cubeInfo.amplitude_range;

    const minVal = ampRange.display_min !== undefined ? ampRange.display_min :
      ampRange.actual_min !== undefined ? ampRange.actual_min :
        ampRange.min || 0;

    const maxVal = ampRange.display_max !== undefined ? ampRange.display_max :
      ampRange.actual_max !== undefined ? ampRange.actual_max :
        ampRange.max || 1;

    return { min: minVal, max: maxVal };
  };

  const handleFileUpload = async (event) => {
    const selectedFiles = Array.from(event.target.files);
    setFiles(selectedFiles);
    setError(null);
    setLoading(true);

    const formData = new FormData();
    selectedFiles.forEach(file => {
      formData.append('files', file);
    });

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
          title: 'x',
          backgroundcolor: backgroundColor === 'black' ? "rgba(40,40,40,0.5)" : "rgba(240,240,240,0.1)",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          titlefont: { size: 24, color: backgroundColor === 'black' ? '#ffffff' : '#000000', family: 'Arial Black, sans-serif' },
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [
            cubeInfo.xline_range.min - (cubeInfo.xline_range.max - cubeInfo.xline_range.min) * 0.05,
            cubeInfo.xline_range.max + (cubeInfo.xline_range.max - cubeInfo.xline_range.min) * 0.15
          ]
        },
        yaxis: {
          title: 'y',
          backgroundcolor: backgroundColor === 'black' ? "rgba(40,40,40,0.5)" : "rgba(240,240,240,0.1)",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          titlefont: { size: 24, color: backgroundColor === 'black' ? '#ffffff' : '#000000', family: 'Arial Black, sans-serif' },
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [
            cubeInfo.inline_range.min - (cubeInfo.inline_range.max - cubeInfo.inline_range.min) * 0.05,
            cubeInfo.inline_range.max + (cubeInfo.inline_range.max - cubeInfo.inline_range.min) * 0.20
          ]
        },
        zaxis: {
          title: 'Sample (Time/Depth) (↑ North)',
          backgroundcolor: backgroundColor === 'black' ? "rgba(40,40,40,0.5)" : "rgba(240,240,240,0.1)",
          gridcolor: backgroundColor === 'black' ? "rgba(200,200,200,0.3)" : "rgba(150,150,150,0.3)",
          showbackground: true,
          titlefont: { size: 14, color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          tickfont: { color: backgroundColor === 'black' ? '#ffffff' : '#000000' },
          range: [cubeInfo.sample_range.max, cubeInfo.sample_range.min],
          autorange: 'reversed'
        },
        bgcolor: backgroundColor === 'black' ? "rgba(20,20,20,1)" : "rgba(255,255,255,0.1)",
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
      width: 1400,
      height: 900,
      margin: { r: 50, b: 10, l: 10, t: 60 },
      dragmode: 'orbit',
      showlegend: false,
      paper_bgcolor: backgroundColor === 'black' ? '#000000' : '#ffffff',
      plot_bgcolor: backgroundColor === 'black' ? '#000000' : '#ffffff'
    };

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
  }, [cubeInfo, sliceData, sliceVisibility, sliceIndices, backgroundColor, updateCompass]);

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

        const hoverString = `INLINE Slice\nINLINE: ${inlineVal}\nXLINE: ${xlineCoords[j]}\nSample: ${sampleCoords[i].toFixed(2)}\nAmplitude: ${amplitude.toFixed(6)}`;
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

        const hoverString = `XLINE Slice\nINLINE: ${inlineCoords[j]}\nXLINE: ${xlineVal}\nSample: ${sampleCoords[i].toFixed(2)}\nAmplitude: ${amplitude.toFixed(6)}`;
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

        const hoverString = `Sample Slice\nINLINE: ${inlineCoords[i]}\nXLINE: ${xlineCoords[j]}\nSample: ${sampleVal.toFixed(2)}\nAmplitude: ${amplitude.toFixed(6)}`;
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
    <div style={{ fontFamily: 'Arial, sans-serif', maxWidth: '1400px', margin: '0 auto', padding: '20px' }}>
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#2c3e50', marginBottom: '10px' }}>3D Seismic Cube Viewer</h1>
      </div>

      <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
        <div style={{ marginBottom: '15px' }}>
          <input
            type="file"
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
            Choose Files
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
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', justifyContent: 'center' }}>
          <div style={{
            backgroundColor: '#f8f9fa',
            padding: '35px',
            borderRadius: '8px',
            minWidth: '600px',
            maxWidth: '650px'
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

            <div style={{ marginTop: '25px' }}>
              <h4 style={{ color: '#34495e', marginBottom: '15px', fontSize: '22px', fontWeight: '600' }}>Background Color</h4>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => handleBackgroundChange('white')}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: backgroundColor === 'white' ? '#3498db' : '#ecf0f1',
                    color: backgroundColor === 'white' ? 'white' : '#2c3e50',
                    border: '2px solid ' + (backgroundColor === 'white' ? '#3498db' : '#bdc3c7'),
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: backgroundColor === 'white' ? 'bold' : 'normal',
                    fontSize: '19px',
                    transition: 'all 0.3s ease'
                  }}
                >
                  White
                </button>
                <button
                  onClick={() => handleBackgroundChange('black')}
                  style={{
                    flex: 1,
                    padding: '12px',
                    backgroundColor: backgroundColor === 'black' ? '#2c3e50' : '#ecf0f1',
                    color: backgroundColor === 'black' ? 'white' : '#2c3e50',
                    border: '2px solid ' + (backgroundColor === 'black' ? '#2c3e50' : '#bdc3c7'),
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: backgroundColor === 'black' ? 'bold' : 'normal',
                    fontSize: '19px',
                    transition: 'all 0.3s ease'
                  }}
                >
                  Black
                </button>
              </div>
            </div>

            {cubeInfo && cubeInfo.amplitude_range && (
              <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#e8f4f8', borderRadius: '6px' }}>
                <h4 style={{ color: '#2c3e50', margin: '0 0 10px 0', fontSize: '22px', fontWeight: '600' }}>Amplitude Statistics</h4>
                <div style={{ fontSize: '17px', color: '#34495e' }}>
                  <div style={{ marginTop: '8px' }}><strong>Actual Range:</strong></div>
                  <div>Min: {cubeInfo.amplitude_range.actual_min?.toFixed(6) || 'N/A'}</div>
                  <div>Max: {cubeInfo.amplitude_range.actual_max?.toFixed(6) || 'N/A'}</div>
                  <div style={{ marginTop: '8px' }}><strong>Display Range (p5-p95):</strong></div>
                  <div>Min: {cubeInfo.amplitude_range.display_min?.toFixed(6) || 'N/A'}</div>
                  <div>Max: {cubeInfo.amplitude_range.display_max?.toFixed(6) || 'N/A'}</div>
                  <div style={{ marginTop: '8px' }}><strong>Statistics:</strong></div>
                  <div>Mean: {cubeInfo.amplitude_range.mean?.toFixed(6) || 'N/A'}</div>
                  <div>Std: {cubeInfo.amplitude_range.std?.toFixed(6) || 'N/A'}</div>
                </div>
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: '1000px', position: 'relative' }}>
            <div
              ref={plotDiv}
              style={{
                width: '100%',
                height: '900px',
                border: '1px solid #ddd',
                borderRadius: '8px',
                backgroundColor: backgroundColor === 'black' ? '#000000' : 'white'
              }}
            />

            <div style={{
              position: 'absolute',
              top: '60px',
              right: '-160px',
              width: '80px',
              height: '80px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000
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
    </div>
  );
};

export default SeismicViewer;
