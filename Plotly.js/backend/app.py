from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import numpy as np
import segyio
import warnings
import zipfile
import tempfile
import shutil
from werkzeug.utils import secure_filename

warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'segy', 'sgy', 'zip'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024 

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# ============================================================================
# ORIENTATION CALCULATION FUNCTIONS
# ============================================================================

def calculate_orientation_from_segy(segy_file_path):
    """
    Calculate the geographic orientation of seismic cube from SEGY headers.
    
    Returns:
        dict: Orientation information including direction vectors and azimuths
    """
    
    print(f"\n{'='*60}")
    print(f"CALCULATING ORIENTATION FOR: {os.path.basename(segy_file_path)}")
    print(f"{'='*60}")
    
    try:
        with segyio.open(segy_file_path, ignore_geometry=True) as f:
            # Collect CDP coordinates and line numbers
            cdp_data = []
            
            print(f"Reading trace headers (sampling first 1000 traces)...")
            
            for i in range(min(1000, len(f.trace))):
                try:
                    header = f.header[i]
                    
                    # Read CDP X, Y coordinates
                    cdp_x = header.get(segyio.TraceField.CDP_X, 
                                      header.get(segyio.TraceField.SourceX, None))
                    cdp_y = header.get(segyio.TraceField.CDP_Y,
                                      header.get(segyio.TraceField.SourceY, None))
                    
                    inline = header.get(segyio.TraceField.INLINE_3D, 0)
                    xline = header.get(segyio.TraceField.CROSSLINE_3D, 0)
                    
                    if cdp_x and cdp_y and inline and xline:
                        cdp_data.append({
                            'x': float(cdp_x),
                            'y': float(cdp_y),
                            'inline': int(inline),
                            'xline': int(xline)
                        })
                        
                except Exception as e:
                    continue
            
            print(f"Found {len(cdp_data)} valid CDP coordinate records")
            
            if len(cdp_data) < 10:
                print("⚠️  WARNING: Insufficient CDP coordinate data found")
                return get_default_orientation()
            
            # Show sample of CDP data
            if len(cdp_data) > 0:
                print(f"\nSample CDP data (first 3 records):")
                for i, d in enumerate(cdp_data[:3]):
                    print(f"  Record {i}: X={d['x']:.2f}, Y={d['y']:.2f}, IL={d['inline']}, XL={d['xline']}")
            
            # Convert to numpy arrays
            cdp_array = np.array([(d['x'], d['y'], d['inline'], d['xline']) 
                                  for d in cdp_data])
            
            print(f"\nCoordinate ranges:")
            print(f"  X: {np.min(cdp_array[:, 0]):.2f} to {np.max(cdp_array[:, 0]):.2f}")
            print(f"  Y: {np.min(cdp_array[:, 1]):.2f} to {np.max(cdp_array[:, 1]):.2f}")
            print(f"  Inline: {int(np.min(cdp_array[:, 2]))} to {int(np.max(cdp_array[:, 2]))}")
            print(f"  Xline: {int(np.min(cdp_array[:, 3]))} to {int(np.max(cdp_array[:, 3]))}")
            
            # CRITICAL FIX: Calculate direction vectors based on coordinate changes
            # Group by inline to find xline direction
            inline_groups = {}
            for d in cdp_data:
                il = d['inline']
                if il not in inline_groups:
                    inline_groups[il] = []
                inline_groups[il].append(d)
            
            # Group by xline to find inline direction
            xline_groups = {}
            for d in cdp_data:
                xl = d['xline']
                if xl not in xline_groups:
                    xline_groups[xl] = []
                xline_groups[xl].append(d)
            
            print(f"\nGrouping analysis:")
            print(f"  Unique inlines: {len(inline_groups)}")
            print(f"  Unique xlines: {len(xline_groups)}")
            
            # Calculate INLINE direction (along constant xline)
            inline_vectors = []
            xline_samples = list(xline_groups.keys())[:5]  # Sample first 5 xlines
            
            print(f"\nCalculating INLINE direction (sampling {len(xline_samples)} constant xlines):")
            for xl in xline_samples:
                points = xline_groups[xl]
                if len(points) >= 2:
                    # Sort by inline number
                    points = sorted(points, key=lambda p: p['inline'])
                    # Calculate direction from first to last point
                    dx = points[-1]['x'] - points[0]['x']
                    dy = points[-1]['y'] - points[0]['y']
                    length = np.sqrt(dx**2 + dy**2)
                    if length > 0:
                        vec = [dx/length, dy/length]
                        inline_vectors.append(vec)
                        print(f"  Xline {xl}: IL {points[0]['inline']}→{points[-1]['inline']}, " +
                              f"vector=[{vec[0]:.4f}, {vec[1]:.4f}], azimuth={np.degrees(np.arctan2(vec[0], vec[1])):.1f}°")
            
            # Calculate XLINE direction (along constant inline)
            xline_vectors = []
            inline_samples = list(inline_groups.keys())[:5]  # Sample first 5 inlines
            
            print(f"\nCalculating XLINE direction (sampling {len(inline_samples)} constant inlines):")
            for il in inline_samples:
                points = inline_groups[il]
                if len(points) >= 2:
                    # Sort by xline number
                    points = sorted(points, key=lambda p: p['xline'])
                    # Calculate direction from first to last point
                    dx = points[-1]['x'] - points[0]['x']
                    dy = points[-1]['y'] - points[0]['y']
                    length = np.sqrt(dx**2 + dy**2)
                    if length > 0:
                        vec = [dx/length, dy/length]
                        xline_vectors.append(vec)
                        print(f"  Inline {il}: XL {points[0]['xline']}→{points[-1]['xline']}, " +
                              f"vector=[{vec[0]:.4f}, {vec[1]:.4f}], azimuth={np.degrees(np.arctan2(vec[0], vec[1])):.1f}°")
            
            if len(inline_vectors) == 0 or len(xline_vectors) == 0:
                print("⚠️  WARNING: Could not calculate direction vectors")
                return get_default_orientation()
            
            # Average the vectors
            inline_vector = np.mean(inline_vectors, axis=0)
            inline_vector = inline_vector / np.linalg.norm(inline_vector)
            
            xline_vector = np.mean(xline_vectors, axis=0)
            xline_vector = xline_vector / np.linalg.norm(xline_vector)
            
            print(f"\nAveraged vectors:")
            print(f"  Inline (averaged from {len(inline_vectors)} samples): [{inline_vector[0]:.6f}, {inline_vector[1]:.6f}]")
            print(f"  Xline (averaged from {len(xline_vectors)} samples): [{xline_vector[0]:.6f}, {xline_vector[1]:.6f}]")
            
            # Ensure vectors are perpendicular
            dot_product = np.dot(inline_vector, xline_vector)
            print(f"\nPerpendicularity check:")
            print(f"  Dot product: {dot_product:.6f} (should be close to 0)")
            
            if abs(dot_product) > 0.1:
                print(f"  ⚠️  WARNING: Vectors not perpendicular! Correcting xline vector...")
                # Make xline perpendicular to inline
                xline_vector = np.array([-inline_vector[1], inline_vector[0]])
                xline_vector = xline_vector / np.linalg.norm(xline_vector)
                print(f"  Corrected xline vector: [{xline_vector[0]:.6f}, {xline_vector[1]:.6f}]")
            
            # Calculate azimuths (measured clockwise from North)
            # Azimuth = atan2(x_component, y_component) * 180/pi
            # Where x is East and y is North
            azimuth_inline = np.degrees(np.arctan2(inline_vector[0], inline_vector[1]))
            if azimuth_inline < 0:
                azimuth_inline += 360
                
            azimuth_xline = np.degrees(np.arctan2(xline_vector[0], xline_vector[1]))
            if azimuth_xline < 0:
                azimuth_xline += 360
            
            # Calculate rotation angle (using xline as reference to North)
            rotation_angle = azimuth_xline
            
            coord_system = detect_coordinate_system(cdp_array[:, 0], cdp_array[:, 1])
            
            orientation_info = {
                'inline_vector': inline_vector.tolist(),
                'xline_vector': xline_vector.tolist(),
                'rotation_angle': float(rotation_angle),
                'azimuth_inline': float(azimuth_inline),
                'azimuth_xline': float(azimuth_xline),
                'has_coordinates': True,
                'coordinate_system': coord_system,
                'coordinate_ranges': {
                    'x_min': float(np.min(cdp_array[:, 0])),
                    'x_max': float(np.max(cdp_array[:, 0])),
                    'y_min': float(np.min(cdp_array[:, 1])),
                    'y_max': float(np.max(cdp_array[:, 1]))
                }
            }
            
            print(f"\n{'='*60}")
            print("✓ ORIENTATION CALCULATION COMPLETE:")
            print(f"{'='*60}")
            print(f"Inline direction vector: ({inline_vector[0]:.6f}, {inline_vector[1]:.6f})")
            print(f"Xline direction vector: ({xline_vector[0]:.6f}, {xline_vector[1]:.6f})")
            print(f"Inline azimuth: {azimuth_inline:.2f}°")
            print(f"Xline azimuth: {azimuth_xline:.2f}°")
            print(f"Rotation from North: {rotation_angle:.2f}°")
            print(f"Coordinate system: {coord_system}")
            print(f"Dot product (perpendicularity): {dot_product:.6f}")
            print(f"{'='*60}\n")
            
            return orientation_info
            
    except Exception as e:
        print(f"\n❌ ERROR calculating orientation: {str(e)}")
        import traceback
        traceback.print_exc()
        return get_default_orientation()


def detect_coordinate_system(x_coords, y_coords):
    """
    Detect the coordinate system type based on coordinate ranges.
    """
    x_range = np.ptp(x_coords)  # peak-to-peak (max - min)
    y_range = np.ptp(y_coords)
    
    x_mean = np.mean(np.abs(x_coords))
    y_mean = np.mean(np.abs(y_coords))
    
    # Check for UTM (typically 6-7 digit numbers)
    if x_mean > 100000 and y_mean > 100000:
        return "UTM"
    
    # Check for State Plane or other local grid
    elif x_mean > 10000 or y_mean > 10000:
        return "Local Grid"
    
    # Check for lat/lon (small decimal numbers)
    elif x_mean < 180 and y_mean < 90:
        return "Geographic (Lat/Lon)"
    
    else:
        return "Unknown"


def get_default_orientation():
    """
    Return default orientation when CDP coordinates are not available.
    
    Default assumes:
    - Inline runs in X direction (East)
    - Xline runs in Y direction (North)
    """
    return {
        'inline_vector': [1.0, 0.0],
        'xline_vector': [0.0, 1.0],
        'rotation_angle': 0.0,
        'azimuth_inline': 90.0,
        'azimuth_xline': 0.0,
        'has_coordinates': False,
        'coordinate_system': 'Assumed Grid'
    }


# ============================================================================
# SEISMIC CUBE PROCESSOR CLASS
# ============================================================================

class SeismicCubeProcessor:
    def __init__(self):
        self.data = None
        self.inline_range = None
        self.xline_range = None
        self.sample_range = None
        self.amplitude_range = None
        self.current_inline_idx = 0
        self.current_xline_idx = 0
        self.current_sample_idx = 0
        self.inline_coords = None
        self.xline_coords = None
        self.sample_coords = None
        self.orientation_info = None
        
    def load_segy_file(self, filepath):
        try:
            print(f"\n{'='*80}")
            print(f"Loading SEGY file: {filepath}")
            print(f"{'='*80}\n")
            
            # IMPORTANT: Reset all data before loading new file
            self.data = None
            self.inline_range = None
            self.xline_range = None
            self.sample_range = None
            self.amplitude_range = None
            self.inline_coords = None
            self.xline_coords = None
            self.sample_coords = None
            self.orientation_info = None
            
            # Calculate orientation from SEGY headers FIRST
            self.orientation_info = calculate_orientation_from_segy(filepath)
            
            with segyio.open(filepath, ignore_geometry=True) as f:
                n_traces = len(f.trace)
                n_samples = len(f.samples)
                
                print(f"Total traces: {n_traces:,}")
                print(f"Samples per trace: {n_samples:,}")
                
                # Get sample coordinates (time/depth)
                self.sample_coords = np.array(f.samples)
                
                inlines = []
                xlines = []
                
                print("Reading trace headers...")
                for i in range(n_traces):
                    try:
                        header = f.header[i]
                        inline = header[segyio.TraceField.INLINE_3D]
                        xline = header[segyio.TraceField.CROSSLINE_3D]
                        
                        if inline != 0 and xline != 0:
                            inlines.append(inline)
                            xlines.append(xline)
                        else:
                            # Fallback to grid-based numbering
                            grid_size = int(np.sqrt(n_traces))
                            inlines.append(i // grid_size + 1)
                            xlines.append(i % grid_size + 1)
                            
                    except Exception:
                        # Fallback to grid-based numbering
                        grid_size = int(np.sqrt(n_traces))
                        inlines.append(i // grid_size + 1)
                        xlines.append(i % grid_size + 1)
                
                unique_inlines = sorted(list(set(inlines)))
                unique_xlines = sorted(list(set(xlines)))
                
                print(f"INLINE range: {min(unique_inlines)} - {max(unique_inlines)} ({len(unique_inlines)} lines)")
                print(f"XLINE range: {min(unique_xlines)} - {max(unique_xlines)} ({len(unique_xlines)} lines)")
                
                # Store coordinate arrays
                self.inline_coords = np.array(unique_inlines)
                self.xline_coords = np.array(unique_xlines)
                
                print("Building 3D data cube...")
                self.data = np.zeros((len(unique_inlines), len(unique_xlines), n_samples))
                
                # Create mapping dictionaries for faster lookup
                inline_map = {il: idx for idx, il in enumerate(unique_inlines)}
                xline_map = {xl: idx for idx, xl in enumerate(unique_xlines)}
                
                for i in range(min(n_traces, len(inlines))):
                    try:
                        inline = inlines[i]
                        xline = xlines[i]
                        
                        if inline in inline_map and xline in xline_map:
                            inline_idx = inline_map[inline]
                            xline_idx = xline_map[xline]
                            
                            trace_data = np.array(f.trace[i])
                            trace_data = np.nan_to_num(trace_data, nan=0.0, posinf=0.0, neginf=0.0)
                            
                            self.data[inline_idx, xline_idx, :] = trace_data
                            
                    except Exception as e:
                        continue
                
                # Set coordinate ranges
                self.inline_range = np.array(unique_inlines)
                self.xline_range = np.array(unique_xlines)
                self.sample_range = self.sample_coords
                
                print("Calculating amplitude statistics...")
                
                clean_data = np.nan_to_num(self.data, nan=0.0, posinf=0.0, neginf=0.0)
                
                # Calculate statistics on all data (including zeros)
                data_min = float(np.min(clean_data))
                data_max = float(np.max(clean_data))
                data_mean = float(np.mean(clean_data))
                data_std = float(np.std(clean_data))
                
                p1 = float(np.percentile(clean_data, 1))
                p99 = float(np.percentile(clean_data, 99))
                p5 = float(np.percentile(clean_data, 5))
                p95 = float(np.percentile(clean_data, 95))
                
                # Store both actual range and display range
                self.amplitude_range = {
                    'actual_min': data_min,
                    'actual_max': data_max,
                    'display_min': p5,
                    'display_max': p95,
                    'mean': data_mean,
                    'std': data_std,
                    'p1': p1,
                    'p99': p99,
                    'p5': p5,
                    'p95': p95
                }
                
                self.current_inline_idx = len(self.inline_range) // 2
                self.current_xline_idx = len(self.xline_range) // 2 
                self.current_sample_idx = len(self.sample_range) // 2
                
                print("SEGY file loaded successfully!")
                print(f"Data shape: {self.data.shape}")
                print(f"Actual amplitude range: {data_min:.6f} to {data_max:.6f}")
                print(f"Display amplitude range (p5-p95): {p5:.6f} to {p95:.6f}")
                print(f"Mean: {data_mean:.6f}, Std: {data_std:.6f}")
                print(f"Memory usage: {self.data.nbytes / (1024**2):.1f} MB")
                
                return True
                
        except Exception as e:
            print(f"Error loading SEGY file: {str(e)}")
            import traceback
            traceback.print_exc()
            return False
    
    def get_slice_data(self, slice_type, index):
        """Get slice data for visualization with proper coordinate mapping"""
        if self.data is None:
            return None
        
        try:
            if slice_type == 'inline':
                data = self.data[index, :, :].T
                coords = {
                    'x': self.xline_coords.tolist(),
                    'y': self.sample_coords.tolist()
                }
                
            elif slice_type == 'xline':
                data = self.data[:, index, :].T
                coords = {
                    'x': self.inline_coords.tolist(),
                    'y': self.sample_coords.tolist()
                }
                
            elif slice_type == 'sample':
                data = self.data[:, :, index]
                coords = {
                    'x': self.inline_coords.tolist(),
                    'y': self.xline_coords.tolist()
                }
            else:
                return None
            
            data = np.array(data)
            data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
            
            return {
                'data': data.tolist(),
                'coordinates': coords,
                'amplitude_stats': {
                    'min': float(np.min(data)),
                    'max': float(np.max(data)),
                    'mean': float(np.mean(data)),
                    'std': float(np.std(data))
                }
            }
            
        except Exception as e:
            print(f"Error getting slice data: {str(e)}")
            return None
    
    def get_cube_info(self):
        """Get cube information with improved metadata"""
        if self.data is None:
            return None
        
        try:
            return {
                'shape': list(self.data.shape),
                'inline_range': {
                    'min': int(self.inline_range.min()),
                    'max': int(self.inline_range.max()),
                    'count': len(self.inline_range)
                },
                'xline_range': {
                    'min': int(self.xline_range.min()),
                    'max': int(self.xline_range.max()),
                    'count': len(self.xline_range)
                },
                'sample_range': {
                    'min': float(self.sample_range.min()),
                    'max': float(self.sample_range.max()),
                    'count': len(self.sample_range)
                },
                'amplitude_range': self.amplitude_range,
                'memory_usage_mb': float(self.data.nbytes / (1024**2)),
                'orientation': self.orientation_info  # Include orientation info
            }
            
        except Exception as e:
            print(f"Error getting cube info: {str(e)}")
            return None

processor = SeismicCubeProcessor()

# ============================================================================
# FLASK API ROUTES
# ============================================================================

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_segy_files(zip_path, extract_to):
    """Extract SEGY files from ZIP archive"""
    segy_files = []
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for file_info in zip_ref.infolist():
                if file_info.filename.lower().endswith(('.segy', '.sgy')):
                    zip_ref.extract(file_info, extract_to)
                    extracted_path = os.path.join(extract_to, file_info.filename)
                    segy_files.append(extracted_path)
                    print(f"Extracted: {file_info.filename}")
    except Exception as e:
        print(f"Error extracting ZIP file: {e}")
    
    return segy_files

@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Handle file upload and processing"""
    if 'files' not in request.files:
        return jsonify({'error': 'No files provided'}), 400
    
    files = request.files.getlist('files')
    if not files or all(file.filename == '' for file in files):
        return jsonify({'error': 'No files selected'}), 400
    
    uploaded_files = []
    segy_files = []
    
    temp_dir = tempfile.mkdtemp()
    
    try:
        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                file.save(filepath)
                uploaded_files.append(filepath)
                
                if filename.lower().endswith('.zip'):
                    extracted_files = extract_segy_files(filepath, temp_dir)
                    segy_files.extend(extracted_files)
                else:
                    segy_files.append(filepath)
        
        if not segy_files:
            return jsonify({'error': 'No SEGY files found in uploaded files'}), 400
        
        first_segy = segy_files[0]
        print(f"Processing SEGY file: {os.path.basename(first_segy)}")
        
        success = processor.load_segy_file(first_segy)
        
        if success:
            cube_info = processor.get_cube_info()
            if cube_info:
                return jsonify({
                    'message': 'Files uploaded and processed successfully',
                    'files': [os.path.basename(f) for f in segy_files],
                    'cube_info': cube_info
                })
            else:
                return jsonify({'error': 'Failed to get cube information'}), 500
        else:
            return jsonify({'error': 'Failed to process SEGY file'}), 500
    
    except Exception as e:
        print(f"Upload error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500
    
    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

@app.route('/api/cube-info', methods=['GET'])
def get_cube_info():
    """Get current cube information"""
    cube_info = processor.get_cube_info()
    if cube_info:
        return jsonify(cube_info)
    else:
        return jsonify({'error': 'No cube data loaded'}), 400

@app.route('/api/slice/<slice_type>/<int:index>', methods=['GET'])
def get_slice(slice_type, index):
    """Get slice data for visualization"""
    if slice_type not in ['inline', 'xline', 'sample']:
        return jsonify({'error': 'Invalid slice type. Must be inline, xline, or sample'}), 400
    
    if processor.data is None:
        return jsonify({'error': 'No cube data loaded'}), 400
    
    max_indices = {
        'inline': processor.data.shape[0] - 1,
        'xline': processor.data.shape[1] - 1,
        'sample': processor.data.shape[2] - 1
    }
    
    if index < 0 or index > max_indices[slice_type]:
        return jsonify({'error': f'Index {index} out of bounds for {slice_type} (max: {max_indices[slice_type]})'}), 400
    
    slice_data = processor.get_slice_data(slice_type, index)
    if slice_data:
        return jsonify(slice_data)
    else:
        return jsonify({'error': 'Failed to get slice data'}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy', 
        'message': 'Seismic Cube Viewer API is running',
        'data_loaded': processor.data is not None
    })

@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': 'File too large. Maximum size is 500MB.'}), 413

@app.errorhandler(500)
def internal_error(e):
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Endpoint not found'}), 404

if __name__ == '__main__':
    print("=" * 60)
    print("Starting Seismic Cube Viewer API...")
    print(f"Upload folder: {os.path.abspath(UPLOAD_FOLDER)}")
    print("Supported file types: .segy, .sgy, .zip")
    print("Max file size: 500MB")
    print("API endpoints:")
    print("  POST /api/upload - Upload SEGY files")
    print("  GET  /api/cube-info - Get cube information") 
    print("  GET  /api/slice/<type>/<index> - Get slice data")
    print("  GET  /api/health - Health check")
    print("=" * 60)
    
    app.run(debug=True, host='0.0.0.0', port=5000)
