# app.py
import os
import io
import json
import tempfile
import traceback
import zipfile
import warnings
from datetime import datetime
from typing import Optional, List, Tuple, Dict
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, Future

import numpy as np
import segyio
from bson import ObjectId
from dotenv import load_dotenv
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from werkzeug.utils import secure_filename
from gzip import compress as gzip_compress

from azure.storage.blob import BlobServiceClient, ContentSettings

warnings.filterwarnings("ignore")
load_dotenv()

app = Flask(__name__)
CORS(app)

# Basic upload settings (kept for debugging / fallback only)
UPLOAD_FOLDER = "uploads"
ALLOWED_EXTENSIONS = {"segy", "sgy", "zip"}
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

AZURE_ACCOUNT_NAME = os.getenv("AZURE_ACCOUNT_NAME", "")
AZURE_ACCOUNT_KEY = os.getenv("AZURE_ACCOUNT_KEY", "")
AZURE_CONTAINER_NAME = os.getenv("AZURE_CONTAINER_NAME", "seismic-data")

blob_service_client: Optional[BlobServiceClient] = None
container_client = None

try:
    if not AZURE_ACCOUNT_NAME or not AZURE_ACCOUNT_KEY:
        raise ValueError("AZURE_ACCOUNT_NAME and AZURE_ACCOUNT_KEY must be provided.")

    account_url = f"https://{AZURE_ACCOUNT_NAME}.blob.core.windows.net"
    blob_service_client = BlobServiceClient(account_url=account_url, credential=AZURE_ACCOUNT_KEY)
    container_client = blob_service_client.get_container_client(AZURE_CONTAINER_NAME)
    if not container_client.exists():
        container_client.create_container()
        print(f"Created Azure container: {AZURE_CONTAINER_NAME}")
    else:
        print(f"Azure container exists: {AZURE_CONTAINER_NAME}")
    print("Azure Blob Storage connected successfully")
except Exception as e:
    print(f"Azure connection failed: {e}")
    traceback.print_exc()
    print("The application will run but data won't persist to Azure Blob (check env vars).")

# Use a small pool for background uploading of slice JSON/.npy to Azure so API responses are immediate.
BG_EXECUTOR = ThreadPoolExecutor(max_workers=4)
BG_FUTURES: List[Future] = []

# Limit the number of cached slices (to control memory). Tune MAX_CACHE_ENTRIES as needed.
MAX_CACHE_ENTRIES = int(os.getenv("MAX_SLICE_CACHE", 200))  # default 200 slices
_slice_cache: "OrderedDict[Tuple[str,str,int], dict]" = OrderedDict()

def lru_cache_get(key):
    try:
        value = _slice_cache.pop(key)
        _slice_cache[key] = value  # re-insert to mark as most-recent
        return value
    except KeyError:
        return None

def lru_cache_set(key, value):
    if key in _slice_cache:
        _slice_cache.pop(key)
    _slice_cache[key] = value
    # evict oldest if over limit
    while len(_slice_cache) > MAX_CACHE_ENTRIES:
        _slice_cache.popitem(last=False)

def azure_upload_bytes(blob_path: str, data_bytes: bytes, content_type: str = "application/octet-stream") -> bool:
    """
    Upload raw bytes to Azure blob. Overwrites if exists.
    Synchronous but used from background executor to avoid blocking client requests.
    """
    if blob_service_client is None:
        print(f"Azure client not configured; skipping upload of {blob_path}")
        return False
    try:
        blob_client = blob_service_client.get_blob_client(container=AZURE_CONTAINER_NAME, blob=blob_path)
        stream = io.BytesIO(data_bytes)
        stream.seek(0)
        blob_client.upload_blob(
            stream,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
            max_concurrency=4,
            timeout=600
        )
        return True
    except Exception as e:
        print(f"Error uploading bytes to Azure ({blob_path}): {type(e).__name__} - {e}")
        traceback.print_exc()
        return False

def azure_download_bytes(blob_path: str) -> Optional[bytes]:
    if blob_service_client is None:
        return None
    try:
        blob_client = blob_service_client.get_blob_client(container=AZURE_CONTAINER_NAME, blob=blob_path)
        stream = blob_client.download_blob()
        data = stream.readall()
        return data
    except Exception:
        return None

def azure_list_blobs(prefix: str = "") -> List[str]:
    if blob_service_client is None:
        return []
    try:
        client = blob_service_client.get_container_client(AZURE_CONTAINER_NAME)
        return [b.name for b in client.list_blobs(name_starts_with=prefix)]
    except Exception as e:
        print(f"Error listing blobs with prefix '{prefix}': {e}")
        traceback.print_exc()
        return []

def azure_delete_blobs(prefix: str) -> List[str]:
    if blob_service_client is None:
        return []
    deleted = []
    try:
        client = blob_service_client.get_container_client(AZURE_CONTAINER_NAME)
        blobs = list(client.list_blobs(name_starts_with=prefix))
        for b in blobs:
            try:
                client.delete_blob(b.name)
                deleted.append(b.name)
            except Exception as e:
                print(f"Warning: failed to delete blob {b.name}: {e}")
        return deleted
    except Exception as e:
        print(f"Error deleting blobs under prefix '{prefix}': {e}")
        traceback.print_exc()
        return deleted

def azure_blob_exists(blob_path: str) -> bool:
    if blob_service_client is None:
        return False
    try:
        blob_client = blob_service_client.get_blob_client(container=AZURE_CONTAINER_NAME, blob=blob_path)
        return blob_client.exists()
    except Exception:
        return False

class SeismicCubeProcessor:
    def __init__(self):
        self.data: Optional[np.ndarray] = None
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
        self.session_id = None
        self.cube_id = None
        self.geometry = None
        self.raw_objects = []

    def load_segy_file(self, filepath: str) -> bool:
        """
        Load SEGY into an in-memory numpy float32 cube.
        The caller is responsible for removing temporary files.
        """
        try:
            print("\n" + "=" * 60)
            print(f"Loading SEGY file: {filepath}")
            print("=" * 60)

            with segyio.open(filepath, ignore_geometry=True) as f:
                n_traces = len(f.trace)
                n_samples = len(f.samples)

                print(f"Total traces: {n_traces:,}")
                print(f"Samples per trace: {n_samples:,}")

                self.sample_coords = np.array(f.samples)

                inlines = []
                xlines = []
                x_coords = []
                y_coords = []

                print("Reading trace headers...")
                for i in range(n_traces):
                    try:
                        header = f.header[i]
                        inline = header.get(segyio.TraceField.INLINE_3D, 0)
                        xline = header.get(segyio.TraceField.CROSSLINE_3D, 0)
                        try:
                            x_coord = header.get(segyio.TraceField.CDP_X, 0)
                            y_coord = header.get(segyio.TraceField.CDP_Y, 0)
                            if (x_coord == 0 or y_coord == 0):
                                x_coord = header.get(segyio.TraceField.SourceX, 0)
                                y_coord = header.get(segyio.TraceField.SourceY, 0)
                        except Exception:
                            x_coord = 0
                            y_coord = 0

                        if inline != 0 and xline != 0:
                            inlines.append(inline)
                            xlines.append(xline)
                            x_coords.append(x_coord)
                            y_coords.append(y_coord)
                        else:
                            grid_size = int(np.sqrt(n_traces)) if n_traces > 0 else 1
                            inlines.append(i // grid_size + 1)
                            xlines.append(i % grid_size + 1)
                            x_coords.append(0)
                            y_coords.append(0)
                    except Exception:
                        grid_size = int(np.sqrt(n_traces)) if n_traces > 0 else 1
                        inlines.append(i // grid_size + 1)
                        xlines.append(i % grid_size + 1)
                        x_coords.append(0)
                        y_coords.append(0)

                unique_inlines = sorted(list(set(inlines)))
                unique_xlines = sorted(list(set(xlines)))

                self.inline_coords = np.array(unique_inlines)
                self.xline_coords = np.array(unique_xlines)

                geometry_info = self.calculate_survey_geometry(inlines, xlines, x_coords, y_coords, unique_inlines, unique_xlines)

                print("Building 3D data cube...")
                # float32 reduces memory and speeds conversions
                self.data = np.zeros((len(unique_inlines), len(unique_xlines), n_samples), dtype=np.float32)

                inline_map = {il: idx for idx, il in enumerate(unique_inlines)}
                xline_map = {xl: idx for idx, xl in enumerate(unique_xlines)}

                for i in range(min(n_traces, len(inlines))):
                    try:
                        inline = inlines[i]
                        xline = xlines[i]

                        if inline in inline_map and xline in xline_map:
                            inline_idx = inline_map[inline]
                            xline_idx = xline_map[xline]

                            trace_data = np.array(f.trace[i], dtype=np.float32)
                            trace_data = np.nan_to_num(trace_data, nan=0.0, posinf=0.0, neginf=0.0)

                            self.data[inline_idx, xline_idx, :] = trace_data
                    except Exception:
                        continue

                self.inline_range = np.array(unique_inlines)
                self.xline_range = np.array(unique_xlines)
                self.sample_range = self.sample_coords
                self.geometry = geometry_info

                print("Calculating amplitude statistics...")
                clean_data = np.nan_to_num(self.data, nan=0.0, posinf=0.0, neginf=0.0)
                data_min = float(np.min(clean_data))
                data_max = float(np.max(clean_data))
                data_mean = float(np.mean(clean_data))
                data_std = float(np.std(clean_data))
                p1 = float(np.percentile(clean_data, 1))
                p99 = float(np.percentile(clean_data, 99))
                p5 = float(np.percentile(clean_data, 5))
                p95 = float(np.percentile(clean_data, 95))

                self.amplitude_range = {
                    "actual_min": data_min,
                    "actual_max": data_max,
                    "display_min": p5,
                    "display_max": p95,
                    "mean": data_mean,
                    "std": data_std,
                    "p1": p1,
                    "p99": p99,
                    "p5": p5,
                    "p95": p95,
                }

                self.current_inline_idx = len(self.inline_range) // 2
                self.current_xline_idx = len(self.xline_range) // 2
                self.current_sample_idx = len(self.sample_range) // 2

                print("SEGY file loaded successfully!")
                print(f"Data shape: {self.data.shape}")
                print(f"Memory usage: {self.data.nbytes / (1024**2):.1f} MB")
                if geometry_info:
                    print(f"  Survey orientation: {geometry_info.get('inline_azimuth', 0):.1f}° from North")
                print("=" * 60 + "\n")

                return True
        except Exception as e:
            print(f"Error loading SEGY file: {e}")
            traceback.print_exc()
            return False

    def calculate_survey_geometry(self, inlines, xlines, x_coords, y_coords, unique_inlines, unique_xlines):
        try:
            coord_map = {(il, xl): (x, y) for il, xl, x, y in zip(inlines, xlines, x_coords, y_coords) if x != 0 and y != 0}

            if len(coord_map) < 4:
                print("Warning: Insufficient coordinate data for geometry calculation.")
                return {"inline_azimuth": 0.0, "xline_azimuth": 90.0, "has_coordinates": False}

            min_il, max_il = min(unique_inlines), max(unique_inlines)
            min_xl, max_xl = min(unique_xlines), max(unique_xlines)

            p1_il_coords = coord_map.get((min_il, min_xl))
            p2_il_coords = coord_map.get((max_il, min_xl))

            if not p1_il_coords or not p2_il_coords:
                for xl_val in unique_xlines:
                    p1_il_coords = coord_map.get((min_il, xl_val))
                    p2_il_coords = coord_map.get((max_il, xl_val))
                    if p1_il_coords and p2_il_coords:
                        break

            p1_xl_coords = coord_map.get((min_il, min_xl))
            p2_xl_coords = coord_map.get((min_il, max_xl))

            if not p1_xl_coords or not p2_xl_coords:
                for il_val in unique_inlines:
                    p1_xl_coords = coord_map.get((il_val, min_xl))
                    p2_xl_coords = coord_map.get((il_val, max_xl))
                    if p1_xl_coords and p2_xl_coords:
                        break

            inline_azimuth = 0.0
            if p1_il_coords and p2_il_coords:
                dx = p2_il_coords[0] - p1_il_coords[0]
                dy = p2_il_coords[1] - p1_il_coords[1]
                inline_azimuth = (np.degrees(np.arctan2(dx, dy)) + 360) % 360

            xline_azimuth = 90.0
            if p1_xl_coords and p2_xl_coords:
                dx = p2_xl_coords[0] - p1_xl_coords[0]
                dy = p2_xl_coords[1] - p1_xl_coords[1]
                xline_azimuth = (np.degrees(np.arctan2(dx, dy)) + 360) % 360

            geometry = {"inline_azimuth": float(inline_azimuth), "xline_azimuth": float(xline_azimuth), "has_coordinates": True}
            print("  Survey geometry calculated:")
            print(f"INLINE azimuth: {inline_azimuth:.1f}° from North")
            print(f"XLINE azimuth: {xline_azimuth:.1f}° from North")
            return geometry
        except Exception as e:
            print(f"Warning: Could not calculate survey geometry: {e}")
            return {"inline_azimuth": 0.0, "xline_azimuth": 90.0, "has_coordinates": False}

    # Save metadata to Azure (metadata JSON only)
    def save_metadata_to_azure(self, filename: str) -> Optional[str]:
        if blob_service_client is None:
            print("Azure client not available - skipping metadata save")
            return None
        try:
            cube_info = self.get_cube_info()
            if cube_info is None:
                return None
            self.cube_id = str(ObjectId())
            document = {
                "filename": filename,
                "session_id": self.session_id,
                "cube_id": self.cube_id,
                "cube_info": cube_info,
                "raw_objects": [],
                "created_at": datetime.utcnow().isoformat(),
                "updated_at": datetime.utcnow().isoformat(),
            }
            metadata_bytes = json.dumps(document).encode("utf-8")
            object_name = f"cubes/{self.cube_id}/metadata.json"
            azure_upload_bytes(object_name, metadata_bytes, content_type="application/json")
            return self.cube_id
        except Exception as e:
            print(f"Error saving metadata to Azure: {e}")
            traceback.print_exc()
            return None

    def _background_upload_slice(self, slice_type: str, index: int, slice_data: dict):
        if not self.cube_id or blob_service_client is None:
            return False
        try:
            json_blob = f"cubes/{self.cube_id}/slices/{slice_type}_{index}.json"
            json_bytes = json.dumps(slice_data, allow_nan=False).encode("utf-8")
            azure_upload_bytes(json_blob, json_bytes, content_type="application/json")
            try:
                arr = np.array(slice_data["data"], dtype=np.float32)
                buf = io.BytesIO()
                np.save(buf, arr, allow_pickle=False)
                buf.seek(0)
                np_blob = f"cubes/{self.cube_id}/slices/{slice_type}_{index}.npy"
                azure_upload_bytes(np_blob, buf.read(), content_type="application/octet-stream")
            except Exception as e:
                print(f"Warning: failed to upload .npy for {slice_type}_{index}: {e}")
            return True
        except Exception as e:
            print(f"Error in background upload of slice {slice_type}_{index}: {e}")
            traceback.print_exc()
            return False

    def save_slice_to_azure_bg(self, slice_type: str, index: int, slice_data: dict):
        fut = BG_EXECUTOR.submit(self._background_upload_slice, slice_type, index, slice_data)
        BG_FUTURES.append(fut)

    def get_slice_data(self, slice_type: str, index: int):
        if self.data is None:
            print("get_slice_data called but self.data is None")
            return None

        if not self.cube_id:
            # no cube id means we haven't saved metadata; still allow on-demand generation
            pass

        cache_key = (self.cube_id or "noid", slice_type, index)
        cached = lru_cache_get(cache_key)
        if cached:
            # Return cached quick JSON (already prepared)
            return cached["slice_dict"]

        # Try Azure cached JSON first if we have cube_id
        if self.cube_id:
            json_blob = f"cubes/{self.cube_id}/slices/{slice_type}_{index}.json"
            bytes_ = azure_download_bytes(json_blob)
            if bytes_:
                try:
                    doc = json.loads(bytes_.decode("utf-8"))
                    # prepare gzip once and cache
                    slice_dict = {"data": doc["data"], "coordinates": doc.get("coordinates", {}), "amplitude_stats": doc.get("amplitude_stats", {})}
                    json_bytes = json.dumps(slice_dict, allow_nan=False).encode("utf-8")
                    gzip_bytes = gzip_compress(json_bytes)
                    cache_entry = {"slice_dict": slice_dict, "json_bytes": json_bytes, "gzip_bytes": gzip_bytes}
                    lru_cache_set(cache_key, cache_entry)
                    print(f"Loaded slice {slice_type}_{index} from Azure cached JSON")
                    return slice_dict
                except Exception as e:
                    print(f"Warning: failed parsing cached JSON from Azure for {json_blob}: {e}")

        # Build slice from in-memory cube (fast)
        try:
            if slice_type == "inline":
                data = self.data[index, :, :]  # shape (xline, samples)
                coords = {"x": self.xline_coords.tolist(), "y": self.sample_coords.tolist()}
                # match frontend orientation: transpose so "rows" correspond to samples (y) and columns to xline
                data_t = np.array(data, dtype=np.float32).T
                arr = np.nan_to_num(data_t, nan=0.0, posinf=0.0, neginf=0.0)
            elif slice_type == "xline":
                data = self.data[:, index, :]  # shape (inline, samples)
                coords = {"x": self.inline_coords.tolist(), "y": self.sample_coords.tolist()}
                data_t = np.array(data, dtype=np.float32).T
                arr = np.nan_to_num(data_t, nan=0.0, posinf=0.0, neginf=0.0)
            elif slice_type == "sample":
                data = self.data[:, :, index]  # shape (inline, xline)
                coords = {"x": self.inline_coords.tolist(), "y": self.xline_coords.tolist()}
                arr = np.nan_to_num(np.array(data, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
            else:
                return None

            amplitude_stats = {
                "min": float(np.min(arr)),
                "max": float(np.max(arr)),
                "mean": float(np.mean(arr)),
                "std": float(np.std(arr)),
            }

            # Convert to nested lists once (costly but unavoidable for JSON)
            data_list = arr.tolist()

            slice_dict = {"data": data_list, "coordinates": coords, "amplitude_stats": amplitude_stats}

            # Prepare bytes and gzipped bytes for fast serving and cache
            json_bytes = json.dumps(slice_dict, allow_nan=False).encode("utf-8")
            gzip_bytes = gzip_compress(json_bytes)

            cache_entry = {"slice_dict": slice_dict, "json_bytes": json_bytes, "gzip_bytes": gzip_bytes}
            lru_cache_set(cache_key, cache_entry)

            # Background upload to Azure for future fast reads (non-blocking)
            if self.cube_id:
                self.save_slice_to_azure_bg(slice_type, index, slice_dict)

            return slice_dict
        except Exception as e:
            print(f"Error building slice data: {e}")
            traceback.print_exc()
            return None

    def get_cube_info(self):
        if self.data is None:
            return None
        try:
            info = {
                "shape": list(self.data.shape),
                "inline_range": {"min": int(self.inline_range.min()), "max": int(self.inline_range.max()), "count": len(self.inline_range)},
                "xline_range": {"min": int(self.xline_range.min()), "max": int(self.xline_range.max()), "count": len(self.xline_range)},
                "sample_range": {"min": float(self.sample_range.min()), "max": float(self.sample_range.max()), "count": len(self.sample_range)},
                "amplitude_range": self.amplitude_range,
                "memory_usage_mb": float(self.data.nbytes / (1024**2)),
                "geometry": getattr(self, "geometry", {"inline_azimuth": 0.0, "xline_azimuth": 90.0, "has_coordinates": False}),
            }
            return info
        except Exception as e:
            print(f"Error getting cube info: {e}")
            traceback.print_exc()
            return None

    # Cache center slices eagerly (still asynchronous uploads)
    def cache_slices_to_azure(self):
        if blob_service_client is None or not self.cube_id:
            print("Skipping eager caching - Azure or cube_id missing.")
            return

        mem_mb = self.data.nbytes / (1024**2)
        full_cache = mem_mb <= 200.0

        def indices_for_axis(axis_len):
            if full_cache:
                return list(range(axis_len))
            center = axis_len // 2
            return list(range(max(0, center - 2), min(axis_len, center + 3)))

        inline_idxs = indices_for_axis(self.data.shape[0])
        xline_idxs = indices_for_axis(self.data.shape[1])
        sample_idxs = indices_for_axis(self.data.shape[2])

        for idx in inline_idxs:
            sd = self.get_slice_data("inline", idx)
            if sd:
                self.save_slice_to_azure_bg("inline", idx, sd)

        for idx in xline_idxs:
            sd = self.get_slice_data("xline", idx)
            if sd:
                self.save_slice_to_azure_bg("xline", idx, sd)

        for idx in sample_idxs:
            sd = self.get_slice_data("sample", idx)
            if sd:
                self.save_slice_to_azure_bg("sample", idx, sd)

processor = SeismicCubeProcessor()

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_segy_bytes_from_zip_bytes(zip_bytes: bytes) -> List[Tuple[str, bytes]]:
    segy_members = []
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zip_ref:
            for file_info in zip_ref.infolist():
                if file_info.filename.lower().endswith((".segy", ".sgy")):
                    with zip_ref.open(file_info) as fh:
                        member_bytes = fh.read()
                        safe_name = secure_filename(os.path.basename(file_info.filename))
                        segy_members.append((safe_name, member_bytes))
    except Exception as e:
        print(f"Error extracting SEGY from zip bytes: {e}")
        traceback.print_exc()
    return segy_members

@app.route("/api/upload", methods=["POST"])
def upload_file():
    """
    Upload endpoint that:
     - reads uploaded files into memory
     - extracts first SEGY (no raw SEGY uploaded to Azure)
     - creates short-lived temp file for segyio
     - loads cube into memory
     - saves metadata.json to Azure
     - enqueues background uploads for cached slice JSON/.npy
    """
    print("\n" + "=" * 60)
    print("Upload request received")
    print("=" * 60)

    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    if not files or all(file.filename == "" for file in files):
        return jsonify({"error": "No files selected"}), 400

    session_id = str(ObjectId())
    processor.session_id = session_id
    print(f"Generated session ID: {session_id}")

    in_memory_segy_candidates = []
    try:
        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                file_bytes = file.read()
                if not file_bytes:
                    print(f"Warning: empty file for {filename}; skipping")
                    continue
                if filename.lower().endswith(".zip"):
                    members = extract_segy_bytes_from_zip_bytes(file_bytes)
                    for name, b in members:
                        in_memory_segy_candidates.append((name, b))
                else:
                    in_memory_segy_candidates.append((filename, file_bytes))

        if not in_memory_segy_candidates:
            return jsonify({"error": "No SEGY files found in uploaded files"}), 400

        # Use first segy candidate
        first_name, first_bytes = in_memory_segy_candidates[0]

        # create short-lived temp file (segyio requires a path in many installs)
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(first_name)[1] or ".segy") as tmp:
                tmp.write(first_bytes)
                tmp.flush()
                temp_path = tmp.name
            print(f"Created temporary processing file: {temp_path} for {first_name}")

            success = processor.load_segy_file(temp_path)
        except Exception as e:
            print(f"Processing error: {e}")
            traceback.print_exc()
            success = False
        finally:
            # delete temp immediately
            try:
                if temp_path and os.path.exists(temp_path):
                    os.remove(temp_path)
                    print(f"Removed temp processing file: {temp_path}")
            except Exception as e:
                print(f"Warning: failed to delete temp file {temp_path}: {e}")

        if not success:
            return jsonify({"error": "Failed to process SEGY file"}), 500

        # Save metadata to Azure
        processor.raw_objects = []
        cube_id = processor.save_metadata_to_azure(os.path.basename(first_name))

        # Eagerly cache center slices asynchronously (background)
        if processor.cube_id:
            # run caching in background (non-blocking)
            BG_EXECUTOR.submit(processor.cache_slices_to_azure)

        cube_info = processor.get_cube_info()
        if cube_info:
            response_data = {
                "message": "Files uploaded and processed successfully",
                "files": [os.path.basename(x[0]) for x in in_memory_segy_candidates],
                "azure_uploaded_objects": [],
                "cube_info": cube_info,
                "cube_id": cube_id,
                "session_id": session_id,
                "azure_connected": blob_service_client is not None,
            }
            print("\nUpload successful")
            print(f"Cube ID: {cube_id}")
            print("=" * 60 + "\n")
            return jsonify(response_data)
        else:
            return jsonify({"error": "Failed to get cube information"}), 500

    except Exception as e:
        print(f"Upload error: {e}")
        traceback.print_exc()
        return jsonify({"error": f"Upload failed: {str(e)}"}), 500

@app.route("/api/cube-info", methods=["GET"])
def get_cube_info():
    cube_info = processor.get_cube_info()
    if cube_info:
        return jsonify(cube_info)
    else:
        return jsonify({"error": "No cube data loaded"}), 400

@app.route("/api/slice/<slice_type>/<int:index>", methods=["GET"])
def get_slice(slice_type, index):
    """
    Fast slice endpoint:
      - Serves from in-memory LRU cache if present (fast).
      - If client accepts gzip, serve gzipped JSON (smaller, faster over network).
      - If not cached but cached in Azure, load from Azure (fast) and cache in-memory.
      - Otherwise build from memory, cache, and respond; also trigger background upload to Azure.
    """
    if slice_type not in ["inline", "xline", "sample"]:
        return jsonify({"error": "Invalid slice type. Must be inline, xline, or sample"}), 400

    if processor.data is None:
        return jsonify({"error": "No cube data loaded"}), 400

    max_indices = {"inline": processor.data.shape[0] - 1, "xline": processor.data.shape[1] - 1, "sample": processor.data.shape[2] - 1}
    if index < 0 or index > max_indices[slice_type]:
        return jsonify({"error": f"Index {index} out of bounds for {slice_type} (max: {max_indices[slice_type]})"}), 400

    cache_key = (processor.cube_id or "noid", slice_type, index)
    cache_entry = lru_cache_get(cache_key)
    accept_encoding = request.headers.get("Accept-Encoding", "")

    if cache_entry:
        # Serve from in-memory cache (super fast)
        if "gzip" in accept_encoding:
            return Response(cache_entry["gzip_bytes"], content_type="application/json", headers={"Content-Encoding": "gzip"})
        else:
            return Response(cache_entry["json_bytes"], content_type="application/json")

    slice_dict = processor.get_slice_data(slice_type, index)
    if not slice_dict:
        return jsonify({"error": "Failed to get slice data"}), 500

    # retrieve the cached entry we set in get_slice_data (it should exist)
    cache_entry = lru_cache_get(cache_key)
    if cache_entry:
        if "gzip" in accept_encoding:
            return Response(cache_entry["gzip_bytes"], content_type="application/json", headers={"Content-Encoding": "gzip"})
        else:
            return Response(cache_entry["json_bytes"], content_type="application/json")

    # fallback: encode on the fly
    json_bytes = json.dumps(slice_dict).encode("utf-8")
    if "gzip" in accept_encoding:
        return Response(gzip_compress(json_bytes), content_type="application/json", headers={"Content-Encoding": "gzip"})
    return Response(json_bytes, content_type="application/json")

@app.route("/api/cubes", methods=["GET"])
def list_cubes():
    if blob_service_client is None:
        return jsonify({"error": "Azure Blob not connected", "cubes": []}), 200
    try:
        cubes = []
        blobs = azure_list_blobs(prefix="cubes/")
        for blob_name in blobs:
            if blob_name.endswith("/metadata.json"):
                try:
                    data = azure_download_bytes(blob_name)
                    if not data:
                        continue
                    document = json.loads(data.decode("utf-8"))
                    document["_id"] = document.get("cube_id")
                    cubes.append(document)
                except Exception as e:
                    print(f"Error processing metadata blob {blob_name}: {e}")
                    continue
        cubes.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return jsonify({"cubes": cubes, "count": len(cubes)})
    except Exception as e:
        print(f"Error listing cubes: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/cube/<cube_id>", methods=["GET"])
def get_cube_by_id(cube_id):
    if blob_service_client is None:
        return jsonify({"error": "Azure Blob not connected"}), 503
    try:
        object_name = f"cubes/{cube_id}/metadata.json"
        data = azure_download_bytes(object_name)
        if not data:
            return jsonify({"error": "Cube not found"}), 404
        document = json.loads(data.decode("utf-8"))
        document["_id"] = document.get("cube_id")
        return jsonify(document)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/cube/<cube_id>", methods=["DELETE"])
def delete_cube(cube_id):
    if blob_service_client is None:
        return jsonify({"error": "Azure Blob not connected"}), 503
    try:
        prefix = f"cubes/{cube_id}/"
        deleted = azure_delete_blobs(prefix=prefix)
        # Also evict any in-memory slices for this cube
        keys_to_remove = [k for k in list(_slice_cache.keys()) if k[0] == cube_id]
        for k in keys_to_remove:
            try:
                _slice_cache.pop(k, None)
            except Exception:
                pass
        if not deleted:
            return jsonify({"error": "Cube not found"}), 404
        return jsonify({"message": "Cube deleted successfully", "deleted_objects_count": len(deleted)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/health", methods=["GET"])
def health_check():
    azure_status = "connected" if blob_service_client is not None else "disconnected"
    return jsonify({
        "status": "healthy",
        "message": "Seismic Cube Viewer API is running",
        "data_loaded": processor.data is not None,
        "azure_status": azure_status,
        "azure_container": AZURE_CONTAINER_NAME if azure_status == "connected" else "Not configured",
    })

# Error handlers
@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": "File too large. Maximum size is 500MB."}), 413

@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "Internal server error"}), 500

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found"}), 404

# CLI / run
if __name__ == "__main__":
    print("\n" + "=" * 60)
    print("Starting Seismic Cube Viewer API (Option 1 - optimized fetching)...")
    print("=" * 60)
    print(f"Upload folder (temp): {os.path.abspath(UPLOAD_FOLDER)}")
    print("Supported file types: .segy, .sgy, .zip")
    print("Max file size: 500MB")
    print(f"Azure Status: {'Connected' if blob_service_client is not None else 'Disconnected'}")
    print(f"Max in-memory slice cache entries: {MAX_CACHE_ENTRIES}")
    print("\nAPI endpoints:")
    print("  POST   /api/upload - Upload SEGY files (SEGY not uploaded; only metadata + slices)")
    print("  GET    /api/cube-info - Get current cube information")
    print("  GET    /api/slice/<type>/<index> - Get slice data (fast; supports gzip)")
    print("  GET    /api/cubes - List all stored cubes")
    print("  GET    /api/cube/<id> - Get cube by ID")
    print("  DELETE /api/cube/<id> - Delete cube")
    print("  GET    /api/health - Health check")
    print("=" * 60 + "\n")

    app.run(debug=True, host="0.0.0.0", port=5000)
