# Destello backend

Python 3.12 package `destello` (FastAPI, arq, astropy). Specifications live in `../docs`; this file
is the map of the code and how to run it.

## Running

Network code needs a working Python 3.12 with SSL. On the Windows development host the uv-managed
interpreter cannot load `_ssl`, so the supported route is the Docker image (target `dev`):

```bash
# build once (installs dependencies from uv.lock)
docker build -t destello-dev --target dev backend

# run anything inside it (source and data are bind mounted)
docker run --rm -v "$PWD/backend:/app" -v "$PWD/data:/data" -v "$PWD/scripts:/scripts" \
  -e PYTHONPATH=/app/src -e DESTELLO_DATA_DIR=/data destello-dev python -m pytest tests -q
docker run --rm ... destello-dev sh -c "ruff check . && ruff format --check . && mypy src"
```

With a normal Python 3.12 the usual commands apply:

```bash
cd backend
uv sync
uv run uvicorn destello.api.main:app --reload
uv run arq destello.worker.main.WorkerSettings
uv run pytest                      # add -m science for the science tests only
uv run ruff check . && uv run ruff format --check . && uv run mypy src
uv run python ../scripts/warm_targets.py [--targets barnard,rdra] [--force] [--report-only]
```

Full stack: `docker compose -f deploy/docker-compose.yml up --build` (see `deploy/`).

## Data modes (`DESTELLO_DATA_MODE`)

| Mode | Behavior |
|---|---|
| `offline` | Cache only. Any request that is not cached raises `OfflineMiss` (code `OFFLINE_CACHE_MISS`). Presets keep working from `DATA_DIR`. |
| `online` | Always query the network; results are still written to the cache. |
| `hybrid` (default) | Cache first, network on a miss; a stale cache entry is used if the network fails. |

Caches: `DATA_DIR/cache/<source>/` (JSON for TAP, SBIdent and resolver results, keyed by query),
`DATA_DIR/cutouts/<xx>/<key>.fits` (content addressed, PSF extension dropped),
`DATA_DIR/calibration/` (solid angle pixel maps), `DATA_DIR/frames/` (WebP and FITS),
`DATA_DIR/manifests/` (manifest and photometry JSON), `DATA_DIR/builds/<id>.json` (sidecar for the API
with the cutout geometry and the exposure list), `DATA_DIR/pins.json` (preset pin list).

## Module map

| Module | Contents |
|---|---|
| `core/config.py` | `Settings` (env prefix `DESTELLO_`), constants with sources (grid 3.1 arcsec, epoch gap 20 d, collections, DOIs, solid angle map paths). |
| `core/logging.py` | `configure_logging`, `get_logger` (structlog JSON). |
| `core/ids.py` | `sequence_id(ra, dec, fov, detectors, release, pipeline_version, mode_params)`, `cutout_key`, `frame_key`. |
| `core/egress.py` | `EgressClient`: https only, host allowlist, redirects only to allowlisted hosts. |
| `core/coords.py` | `parse_coordinates(text) -> (ra_deg, dec_deg)`, raises `CoordinateError` (code `INVALID_COORDINATES`). |
| `core/cache.py` | `JsonCache`, `atomic_write_bytes`. |
| `sources/irsa.py` | `IrsaClient`: `query_images`, `list_releases`, `sia2_query`, `health`, `download_cutout`, `solid_angle_map`. |
| `sources/gaia.py`, `catwise.py` | `GaiaClient.cone / by_source_id`, `CatwiseClient.cone` returning `models.catalog.CatalogSource`. |
| `sources/simbad.py` | `SimbadClient.resolve(name)` (SIMBAD TAP; J2000.0 coordinates). |
| `sources/sbident.py` | `SBIdentClient.identify(ra, dec, time, half_width)` (geocentric approximation). |
| `pipeline/query.py` | ADQL builder, `ImageRecord`, `parse_rows`, `cutout_url`, `cutout_size`. |
| `pipeline/epochs.py` | `group_epochs(times, gap_days=20) -> list[Epoch]`. |
| `pipeline/propagate.py` | `Astrometry`, `propagate_space_motion`, `apparent_positions` (adds geocentric parallax), `parallax_factors`, `mean_position`. |
| `pipeline/calibrate.py` | `load_cutout(hdul, obs_id)`, `calibrate(cutout, sapm)`, flag bits from the FLAGS header, `wavelength_at`, `wavelength_range`, `surface_brightness_to_jy`. |
| `pipeline/reproject.py` | `make_grid(ra, dec, fov)` (TAN, 3.1 arcsec/px, N = round(FoV/3.1)), `reproject_cutout`. |
| `pipeline/coadd.py` | `coadd_stack` (inverse variance, clipped), `broadband_coadd`. |
| `pipeline/render.py` | `compute_stretch` (one per detector over all epochs), `apply_stretch`, `to_webp`, `coadd_fits_bytes`, `diverging_limit`, `apply_diverging`. |
| `pipeline/difference.py` | `difference(a, b) -> DifferenceResult(diff, scale, n_stars)`. |
| `pipeline/photometry.py` | `aperture_photometry`, `forced_photometry` (Jy). |
| `pipeline/astrometry.py` | `measure_centroid`, `fit_offset`, `fit_motion`, `agreement_sigma`. |
| `pipeline/manifest.py`, `models/manifest.py` | Manifest assembly and the pydantic schema (docs/06 section 3.4). |
| `models/targets.py` | `load_targets()`, `find_target(name)` (id, alias, localized name), `parse_epoch`. |
| `worker/jobs.py` | `SequenceParams`, `preset_params(target)`, `params_sequence_id`, `run_build(params, settings, publish)`, arq job `build_sequence`. |
| `worker/cron.py` | `warm_presets`, `check_releases`, `cleanup`. |
| `worker/main.py` | `WorkerSettings`. |
| `api/main.py`, `api/errors.py` | App with `GET /api/v1/health` and RFC 9457 handlers (`ApiError`, `problem`). |

## Notes for the API block

- Enqueue with `arq`: `await pool.enqueue_job("build_sequence", params.to_dict(), _job_id=sequence_id)`
  where `params = SequenceParams(...)` and `sequence_id = params_sequence_id(params, settings)`. Identical
  requests deduplicate on the job id.
- Events are published on Redis channel `destello:seq:<id>` as `{"event": ..., "data": ...}` with the
  events `status`, `progress`, `epoch_ready`, `completed`, `failed`. The latest event is stored at
  `destello:seq:<id>:last` and the state at `destello:seq:<id>:state` (`running`, `ready`, `failed`), both
  with a one day expiry. A sequence is complete when `DATA_DIR/manifests/<id>.json` exists (it is
  written last).
- `release` accepts `all` (default for presets, the union of every science collection) or a collection
  id (`spherex_dr1`, `spherex_qr3`, with its `_deep` companion). A single release has fewer epochs.
- `epoch_ready` is emitted in chronological order after all epochs are coadded and rendered: the
  intensity stretch of a detector is computed over all epochs together, so frames cannot be rendered
  before the last epoch is available. Download progress is reported through `progress` events.
- Preset requests are deterministic: `preset_params(target)` centers on the target position at
  2026-02-01, so presets have stable sequence ids. `DATA_DIR/pins.json` lists them.
- Rendered images are north up, east left. The manifest `grid` carries `orientation:
  "north_up_east_left"`; the FITS coadds keep FITS row order with a WCS.
- Manifest frame `detector` is an integer for per-detector coadds and the string `"all"` for the
  broadband frame (`kind: "broadband"`, unit "normalized", stretch key `"all"`).
- Spectrum and astrometry endpoints can open cutouts through the sidecar
  `DATA_DIR/builds/<id>.json` (`exposures[].path`) and use `pipeline.calibrate.load_cutout`,
  `forced_photometry`, `measure_centroid` and `fit_motion`.

## Tests

`tests/unit` (pure functions), `tests/integration` (sources with respx, API with TestClient and
fakeredis), `tests/science` (marker `science`: real recorded cutouts in `tests/fixtures`).
