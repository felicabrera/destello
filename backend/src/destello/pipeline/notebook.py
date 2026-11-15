"""Jupyter notebook that reproduces a sequence from its manifest (F-36). Pure: no network.

The notebook is generated from the stored manifest only. Every value that enters it is taken from
the manifest model and checked against a strict pattern (observation ids, collections, DOIs,
dates, numbers), so no free text can reach a code cell; the few free text fields (warning
details) are escaped and reduced to one line. The notebook itself performs the downloads when a
user runs it, never the server. It is nbformat 4.5 JSON written without the nbformat package.

It follows the SPHEREx tutorial notebooks of IRSA (https://caltech-ipac.github.io/irsa-tutorials/
spherex/): cutouts by URL with `fits.open`, the spectral WCS with key "W" and `sip = None`, and the
IRSA TAP service through astroquery.
"""

from __future__ import annotations

import json
import re
from typing import Any

from destello.models.manifest import Manifest
from destello.pipeline.calibrate import DEFAULT_MASK_FLAGS
from destello.pipeline.render import ASINH_SOFTENING, HIGH_PERCENTILE

NOTEBOOK_MEDIA_TYPE = "application/x-ipynb+json"
IRSA_BASE = "https://irsa.ipac.caltech.edu/"
GAIA_MAST_TAP = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3"
TUTORIALS_URL = "https://caltech-ipac.github.io/irsa-tutorials/spherex/"
CUTOUT_MARGIN_ARCMIN = 1.0  # same margin as the pipeline (core.config), without the motion term
GAIA_MARGIN_ARCMIN = 3.0  # room for the motion of fast stars between J2016.0 and the survey

# Wording copied from docs/17 (data resources register). A unit test checks that every string
# below still occurs in that document.
ACK_SPHEREX = (
    "This publication makes use of data products from the Spectro-Photometer for the History of "
    "the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of "
    "the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by "
    "the National Aeronautics and Space Administration."
)
ACK_IRSA = (
    "This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the "
    "National Aeronautics and Space Administration and operated by the California Institute of "
    "Technology."
)
CITE_SPHEREX = "please cite the appropriate Digital Object Identifier"
ACK_GAIA = (
    "This work has made use of data from the European Space Agency (ESA) mission Gaia, processed "
    "by the Gaia Data Processing and Analysis Consortium (DPAC). Funding for the DPAC has been "
    "provided by national institutions, in particular the institutions participating in the Gaia "
    "Multilateral Agreement."
)
GAIA_CREDIT = "The Gaia data are open and free to use, provided credit is given to 'ESA/Gaia/DPAC'."
GAIA_MAST_POLICY = "MAST data use policy: not verified."
GAIA_CITES = (
    'Gaia Collaboration et al. (2016b), "The Gaia mission"',
    'Gaia Collaboration et al. (2023j), "Gaia Data Release 3. Summary of the content and survey '
    'properties"',
)
DOCS17_STRINGS = (
    ACK_SPHEREX,
    ACK_IRSA,
    CITE_SPHEREX,
    ACK_GAIA,
    GAIA_CREDIT,
    GAIA_MAST_POLICY,
    *GAIA_CITES,
)

_OBS_ID = re.compile(
    r"^level2_(?P<week>\d{4}W\d{2}_\d[A-Z])_(?P<seq>\d{4})_(?P<n>\d)D(?P<det>[1-6])_spx_"
    r"(?P<ver>[A-Za-z0-9_]+-v\d+-\d{4}-\d{3})$"
)
_COLLECTION = re.compile(r"^spherex_(?P<dir>(?:qr|dr)\d+)$")
_DOI = re.compile(r"^10\.\d{4,9}/[A-Za-z0-9._;()/-]+$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{1,40}$")
_SERVICE = re.compile(r"^[A-Za-z0-9 ()_/:.-]{1,120}$")
_FILE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
_SEQ_ID = re.compile(r"^[0-9a-f]{16}$")


class NotebookError(ValueError):
    """The manifest holds a value that must not enter a notebook."""


def _check(pattern: re.Pattern[str], value: str, what: str) -> str:
    if not pattern.match(value):
        raise NotebookError(f"Unexpected {what} in manifest")
    return value


def clean_line(text: str, limit: int = 300) -> str:
    """One line of plain text for a markdown cell: no em dash, markdown and HTML escaped."""
    text = " ".join(text.replace("\u2014", ",").replace("\u2013", "-").split())[:limit]
    return re.sub(r"([\\`*_{}\[\]<>|#])", r"\\\1", text)


def uri_for(obs_id: str, collection: str) -> str:
    """IRSA relative path of a Level 2 image (docs/03 section 2.2; layout seen in the tutorials)."""
    m = _OBS_ID.match(obs_id)
    c = _COLLECTION.match(collection)
    if m is None or c is None:
        raise NotebookError("Unexpected observation id or collection")
    return f"ibe/data/spherex/{c['dir']}/level2/{m['week']}/{m['ver']}/{m['det']}/{obs_id}.fits"


def sequence_data(m: Manifest) -> dict[str, Any]:
    """The facts the notebook needs, taken from the manifest and validated."""
    _check(_SEQ_ID, m.sequence_id, "sequence id")
    epochs: list[dict[str, Any]] = []
    uris: dict[str, str | None] = {}
    dets: set[int] = set()
    for e in m.epochs:
        frames: dict[str, Any] = {}
        for f in e.frames:
            if f.kind != "coadd" or not isinstance(f.detector, int):
                continue
            ids = [_check(_OBS_ID, o, "observation id") for o in f.obs_ids]
            cols = [_check(_COLLECTION, c, "collection") for c in f.collections]
            for o in ids:
                uris.setdefault(o, uri_for(o, cols[0]) if len(cols) == 1 else None)
            dets.add(f.detector)
            frames[str(f.detector)] = {
                "obs_ids": ids,
                "collections": cols,
                "dois": [_check(_DOI, d, "DOI") for d in f.dois],
                "wavelength_um": list(f.wavelength_um) if f.wavelength_um else None,
                "t_mid_mjd": float(f.t_mid_mjd),
            }
        epochs.append(
            {
                "index": int(e.index),
                "t_start": _check(_ISO, e.t_start, "time"),
                "t_end": _check(_ISO, e.t_end, "time"),
                "t_mid_mjd": float(e.t_mid_mjd),
                "coverage": e.coverage,
                "frames": frames,
            }
        )
    if not uris:
        raise NotebookError("The manifest holds no coadd frames")
    return {
        "sequence_id": m.sequence_id,
        "ra_deg": float(m.request.ra_deg),
        "dec_deg": float(m.request.dec_deg),
        "fov_arcmin": float(m.request.fov_arcmin),
        "grid": {
            "crval_deg": [float(x) for x in m.grid.crval_deg],
            "pixel_scale_arcsec": float(m.grid.pixel_scale_arcsec),
            "naxis": [int(x) for x in m.grid.naxis],
        },
        "detectors": sorted(dets),
        "epochs": epochs,
        "uris": uris,
    }


def _md(cid: str, text: str) -> dict[str, Any]:
    return {"cell_type": "markdown", "id": cid, "metadata": {}, "source": text.strip("\n")}


def _code(cid: str, text: str) -> dict[str, Any]:
    return {
        "cell_type": "code",
        "id": cid,
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": text.strip("\n"),
    }


INTRO = """
# Destello sequence __SID__: reproduction in Python

This notebook rebuilds, in simplified form, the time-lapse of Destello sequence `__SID__`
from the NASA/IPAC IRSA SPHEREx archive. It was generated from the stored manifest of the
sequence (pipeline version __PIPELINE__, built __CREATED__) and contains the exact observation
identifiers, collections and DOIs of that sequence. Nothing in it is simulated: every image is
downloaded from IRSA when the notebook runs.

* Destello view: __VIEW__
* Position (ICRS): RA __RA__ deg, Dec __DEC__ deg; field of view __FOV__ arcmin
* Release request: `__RELEASE__`
* Epochs: __NEPOCH__; images: __NIMG__; detectors: __DETS__

The access patterns follow the official SPHEREx tutorial notebooks of IRSA
([__TUT__](__TUT__)): TAP discovery through astroquery, cutouts by URL read with
`astropy.io.fits`, and the spectral WCS (key `W`) with SIP switched off.

**This is a simplified reproduction.** It does not replace the Destello pipeline. Destello also:

* keeps one image per exposure and detector, the most recently processed one, and reads the
  cutouts from the IRSA copy on AWS when it can (identical pixel values);
* sizes cutouts with an extra margin for the motion of the target across the survey
  (this notebook uses the field of view plus __MARGIN__ arcmin);
* builds a broadband image per epoch, normalising each detector by its field median;
* fits and removes a global shift between epochs, scales one epoch to another with a robust
  field star flux ratio and builds difference images, candidate lists and motion measurements;
* converts to Jy with the solid angle pixel map, runs forced aperture photometry and spectra;
* propagates catalogs with proper motion and the parallax seen from low Earth orbit (this
  notebook applies proper motion only) and reports warnings and quality flags in the manifest.

Data volume: each cutout is a few megabytes, so a sequence with many images takes time to
download. Set `DETECTORS` in the download cell to restrict the run.
"""

REQUIREMENTS = """
# Uncomment to install the dependencies:
# %pip install astropy astroquery pyvo numpy reproject matplotlib

import json
import os
import re
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import astropy.units as u
import matplotlib.pyplot as plt
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.table import Table
from astropy.time import Time
from astropy.utils.data import conf
from astropy.utils.exceptions import AstropyWarning
from astropy.visualization import AsinhStretch, ImageNormalize, ZScaleInterval
from astropy.wcs import WCS
from IPython.display import HTML
from matplotlib.animation import ArtistAnimation
from reproject import reproject_interp

warnings.simplefilter("ignore", AstropyWarning)
conf.remote_timeout = 120  # reading SPHEREx files can exceed the default timeout (IRSA tutorial)
%matplotlib inline
"""

DATA_MD = """
## 3. The sequence: observation ids, collections, DOIs and cutout URLs

The cell below holds the content of the manifest that this reproduction needs. `uris` gives the
relative IRSA path of every image (an entry of `None` is looked up in the IRSA TAP tables when the
notebook runs). The cutout URL of an image is `https://irsa.ipac.caltech.edu/<uri>?center=<ra>,<dec>d&size=<deg>`,
the pattern of the IRSA cutouts tutorial.
"""

DATA_CODE = """
SEQUENCE = json.loads(__JSON__)

RA, DEC = SEQUENCE["ra_deg"], SEQUENCE["dec_deg"]
FOV = SEQUENCE["fov_arcmin"] * u.arcmin
SIZE = FOV + __MARGIN__ * u.arcmin  # cutout side: field of view plus a margin
IRSA = "https://irsa.ipac.caltech.edu/"
CACHE_DIR = Path(os.environ.get("DESTELLO_CACHE_DIR", "destello_cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
URIS = dict(SEQUENCE["uris"])


def observation_id(obs_id):
    return re.match(r"level2_(.+)D[1-6]_spx_", obs_id).group(1)


def resolve_missing_uris():
    \"\"\"Look up in the IRSA TAP tables the paths that the manifest does not determine.\"\"\"
    missing = {o for o, uri in URIS.items() if uri is None}
    if not missing:
        return
    cache = CACHE_DIR / "uri_map.json"
    if cache.exists():
        URIS.update(json.loads(cache.read_text()))
        missing = {o for o in missing if URIS[o] is None}
        if not missing:
            return
    from astroquery.ipac.irsa import Irsa

    ids = ", ".join(f"'{observation_id(o)}'" for o in sorted(missing))
    rows = Irsa.query_tap(
        "SELECT a.uri FROM spherex.artifact a "
        "JOIN spherex.plane p ON a.planeid = p.planeid "
        "JOIN spherex.observation o ON o.obsid = p.obsid "
        f"WHERE o.observationid IN ({ids}) AND a.producttype = 'science'"
    )
    for uri in rows["uri"]:
        stem = str(uri).rsplit("/", 1)[-1].removesuffix(".fits")
        if stem in missing:
            URIS[stem] = str(uri)
    cache.write_text(json.dumps(URIS))


resolve_missing_uris()
left = [o for o, uri in URIS.items() if uri is None]
if left:
    print("Not found in the IRSA tables (skipped):", left)


def cutout_url(obs_id):
    return f"{IRSA}{URIS[obs_id]}?center={RA:.6f},{DEC:.6f}d&size={SIZE.to_value(u.deg):.5f}"


for epoch in SEQUENCE["epochs"]:
    n = sum(len(f["obs_ids"]) for f in epoch["frames"].values())
    print(f"Epoch {epoch['index'] + 1} ({epoch['coverage']} coverage): {epoch['t_start']} to "
          f"{epoch['t_end']}, {n} images")
    for det, frame in epoch["frames"].items():
        print(f"  D{det}: {len(frame['obs_ids'])} images, collections {frame['collections']}, "
              f"DOIs {frame['dois']}")
        for obs_id in frame["obs_ids"][:2]:
            print("     ", obs_id)
            if URIS.get(obs_id):
                print("     ", cutout_url(obs_id))
"""

DOWNLOAD_MD = """
## 4. Download the cutouts

Each cutout is read with `astropy.io.fits` from the IRSA cutout service, as in the tutorial, and
saved in `CACHE_DIR` (environment variable `DESTELLO_CACHE_DIR`, default `destello_cache`). Files
already present are reused, so the cell can be run again. IRSA asks for moderate parallelism: the
tutorial suggests 7 to 12 workers at most; this notebook uses 4.
"""

DOWNLOAD_CODE = """
DETECTORS = __DETECTORS__  # restrict this list to download less

wanted = sorted({
    o
    for e in SEQUENCE["epochs"]
    for d, f in e["frames"].items()
    if int(d) in DETECTORS
    for o in f["obs_ids"]
    if URIS.get(o)
})


def fetch(obs_id):
    path = CACHE_DIR / f"{obs_id}.fits"
    if path.exists():
        return obs_id, "cache"
    last = None
    for attempt in range(3):
        try:
            with fits.open(cutout_url(obs_id), cache=False) as hdul:
                hdul.writeto(path, overwrite=True)
            return obs_id, "downloaded"
        except Exception as exc:  # transient network errors: retry with a pause
            last = exc
            time.sleep(2 ** attempt)
    return obs_id, f"failed: {last}"


with ThreadPoolExecutor(max_workers=4) as pool:
    status = dict(pool.map(fetch, wanted))
failed = {o: s for o, s in status.items() if s.startswith("failed")}
print(f"{len(wanted)} images: "
      f"{sum(s == 'cache' for s in status.values())} from the local cache, "
      f"{sum(s == 'downloaded' for s in status.values())} downloaded, {len(failed)} failed")
for o, s in failed.items():
    print("  ", o, s)
"""

CALIB_MD = """
## 5. Zodiacal light subtraction and the flag mask

Each cutout has the extensions `IMAGE` (MJy/sr), `FLAGS`, `VARIANCE`, `ZODI` and `WCS-WAVE`.
The science image is `IMAGE - ZODI`. The meaning of every bit of `FLAGS` is read from the
header of the file at run time (keywords `MSKN<i>`, `MSKM<i>`, `MSKD<i>`, or `MP_<NAME>` as a
fallback); no bit number is written in this notebook. Pixels with any of the flags in
`MASK_FLAGS` are excluded. The wavelength at the target pixel comes from the spectral WCS
(key `W`) with SIP switched off, as in the IRSA tutorial.
"""

CALIB_CODE = """
# Flags whose pixels Destello excludes from the coadds. SOURCE only marks known sources and is
# never masked.
MASK_FLAGS = __MASK__


def parse_flag_bits(header):
    \"\"\"Flag name -> (bit number, description), read from the FLAGS header.\"\"\"
    bits = {}
    for key in header:
        if key.startswith("MSKN") and key[4:].isdigit():
            value = int(header["MSKM" + key[4:]])
            if value > 0 and value & (value - 1) == 0:
                bits[str(header[key]).strip()] = (
                    value.bit_length() - 1, str(header.get("MSKD" + key[4:], "")))
        elif key.startswith("MP_"):
            bits.setdefault(key[3:], (int(header[key]), str(header.comments[key])))
    return bits


def wcs_cards(header):
    return fits.Header([c for c in header.cards
                        if c.keyword not in ("COMMENT", "HISTORY", "") and len(c.keyword) <= 8])


def load_cutout(obs_id):
    with fits.open(CACHE_DIR / f"{obs_id}.fits") as hdul:
        header = wcs_cards(hdul["IMAGE"].header)
        image = np.asarray(hdul["IMAGE"].data, dtype=float)
        zodi = np.asarray(hdul["ZODI"].data, dtype=float)
        variance = np.asarray(hdul["VARIANCE"].data, dtype=float)
        flags = np.asarray(hdul["FLAGS"].data, dtype=np.int64)
        bits = parse_flag_bits(hdul["FLAGS"].header)
        wcs = WCS(header)
        # Spectral WCS: SIP must be off, astropy would attach the celestial distortion to it.
        wave = None
        try:
            alt = fits.Header([c for c in header.cards
                               if not re.match(r"^(A|B|AP|BP)_(ORDER|DMAX|\\d+_\\d+)$", c.keyword)])
            wave = WCS(alt, fobj=hdul, key="W")
            wave.sip = None
        except Exception:
            wave = None
        wavelength = None
        if wave is not None:
            x, y = wcs.world_to_pixel(SkyCoord(RA * u.deg, DEC * u.deg))
            try:
                wavelength = float(wave.pixel_to_world(x, y)[0].to_value(u.um))
            except Exception:
                wavelength = None
        t_mid = Time(hdul["IMAGE"].header["MJD-AVG"], format="mjd", scale="utc")
    masked = np.zeros(flags.shape, dtype=bool)
    for name in MASK_FLAGS:
        if name in bits:
            masked |= ((flags >> bits[name][0]) & 1) == 1
    science = image - zodi  # zodiacal light model subtracted
    return dict(obs_id=obs_id, science=np.where(masked, np.nan, science),
                variance=np.where(masked, np.nan, variance), wcs=wcs, t_mid=t_mid,
                wavelength=wavelength, bits=bits, masked_fraction=float(masked.mean()))


first = next(o for o in wanted if (CACHE_DIR / f"{o}.fits").exists())
example = load_cutout(first)
print("Flag bits read from the FLAGS header of", first)
for name, (bit, text) in sorted(example["bits"].items(), key=lambda kv: kv[1][0]):
    state = "masked" if name in MASK_FLAGS else "not masked"
    print(f"  bit {bit:2d}  {name:14s} {state:10s} {text}")
print(f"Masked fraction of this cutout: {example['masked_fraction']:.3f}")
"""

COADD_MD = """
## 6. Coadd per epoch and detector, and the blink

Every cutout is reprojected (bilinear) onto the common gnomonic grid of the manifest (north up,
east left), and the cutouts of one epoch and detector are combined with an inverse-variance
weighted mean over the unmasked pixels, as in Destello. The intensity stretch is computed **once
per detector from all its epochs together** (ZScale limits and the __PCT__th percentile, asinh
softening __SOFT__), so that epochs are compared fairly: frames are never stretched on their own.
"""

COADD_CODE = """
GRID_N = SEQUENCE["grid"]["naxis"]
grid_wcs = WCS(naxis=2)
grid_wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
grid_wcs.wcs.crval = SEQUENCE["grid"]["crval_deg"]
grid_wcs.wcs.crpix = [(GRID_N[0] + 1) / 2.0, (GRID_N[1] + 1) / 2.0]
scale = SEQUENCE["grid"]["pixel_scale_arcsec"] / 3600.0
grid_wcs.wcs.cdelt = [-scale, scale]
grid_wcs.wcs.cunit = ["deg", "deg"]
grid_wcs.wcs.radesys = "ICRS"
grid_wcs.pixel_shape = (GRID_N[0], GRID_N[1])


def coadd(obs_ids):
    images, variances, waves = [], [], []
    for obs_id in obs_ids:
        if not (CACHE_DIR / f"{obs_id}.fits").exists():
            continue
        c = load_cutout(obs_id)
        out, _ = reproject_interp((np.stack([c["science"], c["variance"]]), c["wcs"]), grid_wcs,
                                  shape_out=(2, GRID_N[1], GRID_N[0]), order="bilinear")
        sci, var = out[0], out[1]
        bad = ~np.isfinite(sci) | ~np.isfinite(var) | (var <= 0)
        images.append(np.where(bad, np.nan, sci))
        variances.append(np.where(bad, np.nan, var))
        if c["wavelength"] is not None:
            waves.append(c["wavelength"])
    if not images:
        return None
    img, var = np.stack(images), np.stack(variances)
    valid = np.isfinite(img) & np.isfinite(var)
    w = np.where(valid, 1.0 / np.where(valid, var, 1.0), 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (w * np.where(valid, img, 0.0)).sum(axis=0) / w.sum(axis=0)
    mean[valid.sum(axis=0) == 0] = np.nan
    return dict(image=mean, n=len(images), waves=waves)


coadds = {}  # (epoch index, detector) -> coadd
for epoch in SEQUENCE["epochs"]:
    for det, frame in epoch["frames"].items():
        if int(det) in DETECTORS:
            result = coadd(frame["obs_ids"])
            if result is not None:
                result["t_mid_mjd"] = frame["t_mid_mjd"]
                coadds[(epoch["index"], int(det))] = result

for (index, det), c in sorted(coadds.items()):
    wave = f"{min(c['waves']):.2f} to {max(c['waves']):.2f} um" if c["waves"] else "n/a"
    print(f"Epoch {index + 1}, D{det}: {c['n']} images, wavelength at the target {wave}")


def shared_norm(det):
    pooled = np.concatenate([c["image"].ravel() for (i, d), c in coadds.items() if d == det])
    pooled = pooled[np.isfinite(pooled)]
    z1, z2 = ZScaleInterval().get_limits(pooled)
    vmax = max(z2, np.percentile(pooled, __PCT__))
    return ImageNormalize(vmin=z1, vmax=vmax, stretch=AsinhStretch(a=__SOFT__))


norms = {det: shared_norm(det) for det in sorted({d for _, d in coadds})}


def blink(det):
    fig, ax = plt.subplots(figsize=(4.2, 4.4))
    frames = []
    for (index, d), c in sorted(coadds.items()):
        if d != det:
            continue
        im = ax.imshow(c["image"], origin="lower", cmap="gray", norm=norms[det], animated=True)
        label = ax.text(0.03, 0.95, f"D{det}  epoch {index + 1}  MJD {c['t_mid_mjd']:.2f}",
                        transform=ax.transAxes, color="white", va="top", fontsize=9)
        frames.append([im, label])
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("North up, east left; one stretch for all epochs", fontsize=8)
    anim = ArtistAnimation(fig, frames, interval=500, repeat=True)
    html = HTML(anim.to_jshtml())
    plt.close(fig)
    return html


detectors_done = sorted(norms)
if detectors_done:
    display(blink(detectors_done[0]))  # play the animation with the controls under the image
"""

GAIA_MD = """
## 7. Catalog positions at each epoch (Gaia DR3 from MAST)

Gaia DR3 positions have the reference epoch J2016.0. Comparing them with an image taken years
later requires propagating each source with its proper motion to the observation time of each
epoch; positions at different epochs are never compared without propagation. The catalog is read
from the MAST VO TAP service for Gaia DR3 (`dbo.gaia_source`) through pyvo. The answer is saved in
`CACHE_DIR` and reused. Here only space motion is applied (no parallax shift); Destello also
applies the parallax seen from low Earth orbit.
"""

GAIA_CODE = """
GAIA_TAP = "__GAIATAP__"
radius = (np.hypot(*GRID_N) * SEQUENCE["grid"]["pixel_scale_arcsec"] / 2.0 * u.arcsec
          + __GMARGIN__ * u.arcmin).to(u.deg)
gaia_cache = CACHE_DIR / "gaia_dr3.vot"
if gaia_cache.exists():
    gaia = Table.read(gaia_cache, format="votable")
    print("Gaia DR3 sources read from the local cache:", len(gaia))
else:
    import pyvo

    adql = (
        "SELECT TOP 2000 source_id, ra, dec, pmra, pmdec, parallax, ref_epoch, phot_g_mean_mag "
        "FROM dbo.gaia_source "
        f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {RA:.7f}, {DEC:.7f}, "
        f"{radius.value:.6f})) ORDER BY phot_g_mean_mag"
    )
    gaia = pyvo.dal.TAPService(GAIA_TAP).run_sync(adql).to_table()
    gaia.write(gaia_cache, format="votable", overwrite=True)
    print("Gaia DR3 sources from MAST:", len(gaia))


def propagate(table, mjd):
    \"\"\"Gaia DR3 sources moved from their reference epoch to an observation time (MJD, UTC).\"\"\"
    ok = np.isfinite(table["pmra"]) & np.isfinite(table["pmdec"])
    t = table[ok]
    ref = Time(float(np.ma.filled(t["ref_epoch"], 2016.0)[0]), format="jyear")
    plx = np.ma.filled(t["parallax"].astype(float), 0.0)
    distance = np.where(plx > 0, 1000.0 / np.where(plx > 0, plx, 1.0), 1.0e6) * u.pc
    coord = SkyCoord(
        ra=np.asarray(t["ra"], dtype=float) * u.deg, dec=np.asarray(t["dec"], dtype=float) * u.deg,
        pm_ra_cosdec=np.asarray(t["pmra"], dtype=float) * u.mas / u.yr,
        pm_dec=np.asarray(t["pmdec"], dtype=float) * u.mas / u.yr,
        distance=distance, radial_velocity=np.zeros(len(t)) * u.km / u.s,
        obstime=ref, frame="icrs")
    return t, coord.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="utc"))


if detectors_done:
    det = detectors_done[0]
    keys = sorted(k for k in coadds if k[1] == det)
    fig, axes = plt.subplots(1, len(keys), figsize=(3.4 * len(keys), 3.8), squeeze=False)
    for ax, key in zip(axes[0], keys):
        c = coadds[key]
        ax.imshow(c["image"], origin="lower", cmap="gray", norm=norms[det])
        t, moved = propagate(gaia, c["t_mid_mjd"])
        x, y = grid_wcs.world_to_pixel(moved)
        inside = (x >= 0) & (x < GRID_N[0]) & (y >= 0) & (y < GRID_N[1])
        bright = np.argsort(np.ma.filled(t["phot_g_mean_mag"].astype(float), 99.0))
        pick = [i for i in bright if inside[i]][:40]
        ax.scatter(x[pick], y[pick], s=70, facecolors="none", edgecolors="tab:cyan", linewidths=0.8)
        ax.set_title(f"D{det} epoch {key[0] + 1}, MJD {c['t_mid_mjd']:.1f}", fontsize=9)
        ax.set_xticks([])
        ax.set_yticks([])
    fig.suptitle("Gaia DR3 sources propagated to each epoch", fontsize=10)
    plt.show()

    # How far the fastest source in the field moves between the first and the last epoch.
    t, a = propagate(gaia, coadds[keys[0]]["t_mid_mjd"])
    _, b = propagate(gaia, coadds[keys[-1]]["t_mid_mjd"])
    shift = a.separation(b).to(u.arcsec)
    i = int(np.argmax(shift))
    print(f"Largest motion between epochs {keys[0][0] + 1} and {keys[-1][0] + 1}: "
          f"{shift[i]:.1f} (Gaia DR3 {t['source_id'][i]})")
"""

CITE_MD = """
## 8. Citation and acknowledgement

**Data.** SPHEREx images served by NASA/IPAC IRSA. Collections: __COLLECTIONS__. DOIs of the
releases used (__CITENOTE__): __DOIS__. Services used by Destello for this sequence: __SERVICES__.
__DATES__

Acknowledgement text from the IRSA overview (as recorded in the Destello data resources register):

> __ACK_SPHEREX__

IRSA statement: "__ACK_IRSA__"

**Catalog.** Gaia DR3 through NASA MAST. ESA credit: "__GAIA_CREDIT__" Acknowledgement text
from the ESA page:

> __ACK_GAIA__

Citations listed by ESA: __GAIA_CITES__. __GAIA_POLICY__ The register does not state a MAST licence.

**Methods.** SPHEREx Tutorial Notebooks, Caltech/IPAC IRSA ([__TUT__](__TUT__)): access
patterns, spectral WCS handling.

**Software.** Destello pipeline __PIPELINE__ (sequence `__SID__`, built __CREATED__);
view __VIEW__.
__WARNINGS__
"""

CITE_CODE = """
print("SPHEREx data DOIs used in this sequence:")
for doi in sorted({d for e in SEQUENCE["epochs"] for f in e["frames"].values() for d in f["dois"]}):
    print("  https://doi.org/" + doi)
print("Sequence:", SEQUENCE["sequence_id"])
"""


def _fill(text: str, values: dict[str, str]) -> str:
    for key, val in values.items():
        text = text.replace(f"__{key}__", val)
    return text


def build_notebook(m: Manifest, public_url: str) -> dict[str, Any]:
    """The notebook (nbformat 4.5 as a dict) for a manifest."""
    data = sequence_data(m)
    sid = data["sequence_id"]
    view = f"{public_url.rstrip('/')}/?seq={sid}"
    if not re.match(r"^https?://[A-Za-z0-9.:-]+(?:/[A-Za-z0-9._~/-]*)?\?seq=[0-9a-f]{16}$", view):
        raise NotebookError("Unexpected public URL")
    prov = m.provenance
    collections = [_check(_COLLECTION, c, "collection") for c in prov.collections]
    dois = [_check(_DOI, d, "DOI") for d in prov.dois]
    services = [_check(_SERVICE, s, "service") for s in prov.services]
    dates = [_check(_DATE, d, "date") for d in prov.data_release_dates]
    for f in prov.solid_angle_maps:
        _check(_FILE, f, "file name")
    warnings = [(_check(_CODE, w.code, "warning code"), clean_line(w.detail)) for w in m.warnings]
    n_img = sum(len(f["obs_ids"]) for e in data["epochs"] for f in e["frames"].values())
    dets = data["detectors"]
    release = clean_line(m.request.release, 40)
    shared = {
        "SID": sid,
        "VIEW": view,
        "TUT": TUTORIALS_URL,
        "PIPELINE": clean_line(m.pipeline_version, 40),
        "CREATED": _check(_ISO, m.created_at, "time"),
        "MARGIN": f"{CUTOUT_MARGIN_ARCMIN:g}",
    }
    intro = _fill(
        INTRO,
        {
            **shared,
            "RA": f"{data['ra_deg']:.5f}",
            "DEC": f"{data['dec_deg']:.5f}",
            "FOV": f"{data['fov_arcmin']:g}",
            "RELEASE": release,
            "NEPOCH": str(len(data["epochs"])),
            "NIMG": str(n_img),
            "DETS": ", ".join(f"D{d}" for d in dets),
        },
    )
    cite = _fill(
        CITE_MD,
        {
            **shared,
            "COLLECTIONS": ", ".join(f"`{c}`" for c in collections),
            "CITENOTE": CITE_SPHEREX,
            "DOIS": ", ".join(f"[{d}](https://doi.org/{d})" for d in dois),
            "SERVICES": "; ".join(clean_line(s, 120) for s in services),
            "DATES": ("Data release dates: " + ", ".join(dates) + ".") if dates else "",
            "ACK_SPHEREX": ACK_SPHEREX,
            "ACK_IRSA": ACK_IRSA,
            "GAIA_CREDIT": GAIA_CREDIT,
            "ACK_GAIA": ACK_GAIA,
            "GAIA_CITES": "; ".join(GAIA_CITES),
            "GAIA_POLICY": GAIA_MAST_POLICY,
            "WARNINGS": (
                "\n**Warnings recorded in the manifest.**\n\n"
                + "\n".join(f"* `{c}`: {d}" for c, d in warnings)
                if warnings
                else ""
            ),
        },
    )
    payload = repr(json.dumps(data, separators=(",", ":"), ensure_ascii=True))
    cells = [
        _md("destello-01", intro),
        _md("destello-02", "## 2. Requirements and imports"),
        _code("destello-03", REQUIREMENTS),
        _md("destello-04", DATA_MD),
        _code(
            "destello-05",
            _fill(DATA_CODE, {"JSON": payload, "MARGIN": f"{CUTOUT_MARGIN_ARCMIN:g}"}),
        ),
        _md("destello-06", DOWNLOAD_MD),
        _code("destello-07", _fill(DOWNLOAD_CODE, {"DETECTORS": repr(dets)})),
        _md("destello-08", CALIB_MD),
        _code(
            "destello-09",
            _fill(CALIB_CODE, {"MASK": repr(list(DEFAULT_MASK_FLAGS))}),
        ),
        _md(
            "destello-10",
            _fill(COADD_MD, {"PCT": f"{HIGH_PERCENTILE:g}", "SOFT": f"{ASINH_SOFTENING:g}"}),
        ),
        _code(
            "destello-11",
            _fill(COADD_CODE, {"PCT": f"{HIGH_PERCENTILE:g}", "SOFT": f"{ASINH_SOFTENING:g}"}),
        ),
        _md("destello-12", GAIA_MD),
        _code(
            "destello-13",
            _fill(GAIA_CODE, {"GAIATAP": GAIA_MAST_TAP, "GMARGIN": f"{GAIA_MARGIN_ARCMIN:g}"}),
        ),
        _md("destello-14", cite),
        _code("destello-15", CITE_CODE),
    ]
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
            "destello": {"sequence_id": sid, "pipeline_version": shared["PIPELINE"]},
        },
        "cells": cells,
    }


def notebook_json(m: Manifest, public_url: str) -> str:
    return json.dumps(build_notebook(m, public_url), indent=1, ensure_ascii=True) + "\n"
