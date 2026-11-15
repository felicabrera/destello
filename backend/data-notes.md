# Data notes: findings from the live IRSA spike (2026-11-09)

These notes record what was observed against the live services while building B1. Every statement
here was checked with a real request unless marked otherwise. They replace the `[VERIFY]` marks in
`docs/03` for the items listed.

## Environment constraints seen during the spike

- Reachable: IRSA (irsa.ipac.caltech.edu), ESA Gaia archive (gea.esac.esa.int), JPL SSD API.
- Not reachable from this environment: all CDS hosts (simbad.cds.unistra.fr, cds.unistra.fr,
  vizier, alasky). `sources/simbad.py` is therefore covered by recorded-response tests only, and
  the reference astrometry of the five targets was pinned from Gaia DR3 and CatWISE2020 instead of
  SIMBAD. Hybrid or offline data mode keeps the product working when CDS is down.
- The uv-managed Python 3.12 on the Windows host cannot load `_ssl` (Application Control policy),
  so all network code and tests run inside the Docker image built from `backend/Dockerfile`
  (target `dev`). Unit tests that do not touch the network also work with any Python 3.12.

## IRSA TAP (https://irsa.ipac.caltech.edu/TAP/sync)

Tables: `spherex.plane` (one row per detector image), `spherex.artifact` (file URI),
`spherex.observation` (collection), `spherex.obscore`, `spherex.provenance_input`.

| Table | Columns used |
|---|---|
| `spherex.plane p` | `planeid`, `obsid`, `productid` (`D1` to `D6`), `energy_bounds_lower/upper` (metres, nominal detector band), `time_bounds_lower/upper` (MJD, UTC), `time_exposure` (s), `poly` (footprint), `datarelease`, `metarelease` |
| `spherex.artifact a` | `planeid`, `uri` (relative path, prepend `https://irsa.ipac.caltech.edu/`), `producttype` (`science` or `calibration`), `contentlength` (about 71.6 MB per full image) |
| `spherex.observation o` | `obsid`, `collection`, `observationid` (for example `2025W33_2C_0321_1`) |

Discovery pattern (one query, all detectors, with times):

```sql
SELECT p.planeid, p.obsid, p.productid, p.energy_bounds_lower, p.energy_bounds_upper,
       p.time_bounds_lower, p.time_bounds_upper, p.time_exposure, a.uri, a.contentlength,
       o.collection, o.observationid
FROM spherex.plane p JOIN spherex.artifact a ON a.planeid = p.planeid
JOIN spherex.observation o ON o.obsid = p.obsid
WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), p.poly) AND o.collection IN (...)
  AND a.producttype = 'science' ORDER BY p.time_bounds_lower
```

Latency: about 5 s for a position, returns every detector image whose footprint contains it.
Barnard's Star returned 364 images (one per detector per exposure).

Collections present: `spherex_qr2`, `spherex_qr2_cal`, `spherex_qr2_deep`, `spherex_qr3`,
`spherex_qr3_cal`, `spherex_qr3_deep`. Science images are in the four non-`_cal` collections. The
`spherex_qr2` collection still receives data into 2026 (it holds observations up to 2026W19), and
`spherex_qr3` starts at 2026W34; the two are disjoint in time, so the product defaults to the union
(`release = "all"`) to give three or more epochs.

Update 2026-11-14 (TAP, same query): the collections are now `spherex_dr1`, `spherex_dr1_cal`,
`spherex_dr1_deep`, `spherex_qr3` and `spherex_qr3_deep`. IRSA published Data Release 1 on
2026-11-12 and removed `spherex_qr2` and `spherex_qr2_deep` from TAP. `spherex_dr1` holds the
reprocessed Quick Release 2 images (pipeline v27, MJD 60789.75 to 61174.49, 945725 planes) and
`spherex_qr3` now starts at MJD 61174.51, so the two remain disjoint in time. The Quick Release 2
files still download by path. Science collections queried: the four non-`_cal` ones
(`core/config.py` `SCIENCE_COLLECTIONS`). Bucket keys of DR1 follow the same layout
(`dr1/level2/<week>/l2b-v27-<date>/<d>/...fits`).

SIA2 (`https://irsa.ipac.caltech.edu/SIA?COLLECTION=...&POS=circle ra dec r&RESPONSEFORMAT=csv`)
works and returns `access_url`, `t_min`, `t_max`, `obs_id`. TAP is used as the primary path
because one query yields the times and the file URIs.

Availability probe: `GET /TAP/availability` returns a VOSI document with `<available>true`.

## Cutouts

- URL: `https://irsa.ipac.caltech.edu/<uri>?center=<ra>,<dec>d&size=<deg>`; `size` is the side in
  degrees (0.1 gave 58 x 59 native pixels).
- Cost: 15 to 19 s per cutout and 5.1 MB, because the PSF extension (101 x 101 x 121 float32 cube)
  is 4.9 MB. No query parameter reduces the extensions (`ext`, `extname`, `hdus`, `nopsf` are
  ignored). The server answers `503 Server busy` under load; the client retries with exponential
  backoff and jitter. Concurrency is capped at 8.
- Cached cutouts keep PSF out (about 25 times smaller): extensions kept are `IMAGE`, `FLAGS`,
  `VARIANCE`, `ZODI`, `WCS-WAVE`.
- Extensions (confirmed): `PRIMARY`, `IMAGE` (MJy/sr, `BUNIT = 'MJy / sr'`), `FLAGS` (int32),
  `VARIANCE` (`MJy2 / sr2`), `ZODI` (`MJy / sr`, model `ModifiedKelsallModelWithHPFT`), `PSF`,
  `WCS-WAVE` (binary table with columns `X`, `Y`, `VALUES`).
- `IMAGE` includes the zodiacal light: science = `IMAGE - ZODI` (median IMAGE 0.46, ZODI 0.32
  MJy/sr in the Barnard D6 test cutout).
- Celestial WCS: TAN with SIP (`RA---TAN-SIP`). Cutout pixel (FITS) to detector pixel through WCS
  key `A` (`LINEAR`, 0-based active pixel coordinates).
- Time keywords: `MJD-BEG`, `MJD-AVG`, `MJD-END`, `DATE-AVG` (UTC), `XPOSURE` (s, about 113.6).
  Other useful keywords: `DETECTOR`, `OBSID`, `PSF_FWHM` (arcsec, about 6.6 in D6),
  `OMEGA_MEDIAN` (median pixel solid angle in arcsec^2, about 37.9), `FINAST`.

### Cutout throughput (2026-11-10, Kapteyn field, RA 77.9599, Dec -45.0044, 7 arcmin cutouts)

- Discovery (TAP): 369 records in 7.1 s.
- IRSA cutout service, 8 concurrent: time to first byte 1.54 s, transfer 11.54 s, total 13.08 s
  per cutout, 4.85 MB each; 1 or 2 of 10 answered `503 Server busy`. One stream alone: first
  byte 0.82 s, transfer 9.10 s (about 0.5 MB/s). The cost is the transfer, and 96 percent of the
  bytes are the PSF cube (v20 and v24 files 96.3 percent, EPSF in v27 95.9 percent).
- `gzip=true` on the cutout URL: 15 percent fewer bytes, about 17 percent faster. Used.
- Concurrency scope: the bound of 8 was a semaphore per process (API, worker, release check each
  had their own). It is now one Redis lease set per host shared by all processes
  (`core/limiter.py`).

### Cutouts from the AWS open data copy (bucket `nasa-irsa-spherex`)

- The same Level 2 files are public in `s3://nasa-irsa-spherex` (us-east-1), uncompressed MEF of
  66 to 72 MB; in qr3 the FLAGS extension can be tile compressed (RICE). The key of each image is
  in the `cloud_access` column of an IRSA SIA2 query (JSON `{"aws": {"bucket_name", "key",
  "region"}}`), 1.62 s for the 369 images of the field. Anonymous HTTPS range reads work on
  `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/<key>`.
- Throughput from this host: one 16 MB read 2.20 MB/s; 16 parallel 4 MB reads 5.07 MB/s in total;
  small request latency 0.158 s.
- Range read cutouts (`sources/s3.py`): headers, the rows of IMAGE, FLAGS, VARIANCE and ZODI in the
  box, and the WCS-WAVE table; the PSF is skipped. About 9.3 requests and 2.29 MB per cutout.
- Live comparison, 16 images of the field: S3 at 16 concurrent took 10.2 s wall clock (9.07 s mean
  per cutout, 36.6 MB in total); the IRSA service one at a time took 119.9 s (7.5 s each, 63.7 MB).
  Throughput about 1.6 cutouts per second from S3 against about 0.6 from IRSA at 8 concurrent.
- Equality: IMAGE, FLAGS (also when tile compressed in the bucket), VARIANCE and ZODI pixels equal
  on 16 of 16 images, WCS-WAVE bytes equal, headers equal except NAXIS and CRPIX.
- Box rule (fitted against IRSA): center from the full WCS including SIP, pixel scale per axis from
  the PC and CDELT columns, half size h, first pixel ceil(c - h), length round(2h), clipped to the
  image. Equal to the IRSA box on 30 of 32 axes (14 of 16 images). On the other 2 axes the size is
  equal and IRSA starts one pixel later (D3 qr2 2025W36 x, center fraction 0.9253; D6 qr2 2025W35
  y, 0.9077). Accepted: at most one pixel of offset inside the cutout margin, no pixel value
  changes, and every cutout is reprojected onto the sequence grid.

## Flag bits (read from the FLAGS header at runtime, never hardcoded)

Header keyword triplets `MSKN<i>` (name), `MSKM<i>` (mask value, power of two), `MSKD<i>` (description); the bit number is log2 of the mask value (the earlier note about MP_<NAME> keywords was wrong for the cutouts, corrected 2026-11-09). Bits seen: TRANSIENT 0, OVERFLOW 1, SUR_ERROR 2, PHANTOM 4,
REFERENCE 5, NONFUNC 6, DICHROIC 7, MISSING_DATA 9, HOT 10, COLD 11, FULLSAMPLE 12, PHANMISS 14,
NONLINEAR 15, PERSIST 17, OUTLIER 19, CROSSTALK 20, SOURCE 21, GHOST 22, GHOST_FPA 23, GHOST_EXT 24, STREAK 25, BLOOM 26, SNOWBALL 27, HALO 28. The pipeline masks all except SOURCE (pixels mapped
to a known source), FULLSAMPLE and PHANMISS (informational). Saturation related flags used to
exclude pixels from centroids: OVERFLOW, NONLINEAR, TRANSIENT, SUR_ERROR.

## Spectral WCS

`WCS(image_header, fobj=hdulist, key="W")` works. Both output axes are `WAVE-TAB` in micron: the
first is the wavelength, the second the bandwidth. `wcs.pixel_to_world_values(x, y)` returns
`(wavelength_um, bandwidth_um)` for 0-based cutout pixels. Example: D6 pixel (10, 10) returned
4.908 and 0.0369 micron. Astropy logs an INFO about SIP for keys A and W (CTYPE lacks -SIP). Decision: SIP is intended only for the celestial WCS (RA---TAN-SIP), which astropy applies, and it is the WCS used for all reprojection, forced photometry and centroid predictions (validated to about 0.1 native pixel on Barnard). The notice is filtered by `core.logging.silence_known_astropy_noise` because it fires once per cutout and carries no information.

## Solid angle pixel map

Per detector, per release, in the calibration area of each release:

- QR2: `ibe/data/spherex/qr2/solid_angle_pixel_map/cal-sapm-v2-2025-164/<d>/solid_angle_pixel_map_D<d>_spx_cal-sapm-v2-2025-164.fits`
- QR3: `ibe/data/spherex/qr3/solid_angle_pixel_map/cal-sapm-v3-2026-191/<d>/solid_angle_pixel_map_D<d>_spx_cal-sapm-v3-2026-191.fits`
- DR1: `ibe/data/spherex/dr1/solid_angle_pixel_map/cal-sapm-v3-2026-191/<d>/solid_angle_pixel_map_D<d>_spx_cal-sapm-v3-2026-191.fits` (same version as QR3; listed in the bucket on 2026-11-14)

Format: `IMAGE` extension, 2040 x 2040 float32, `BUNIT = arcsec2`, `DETCOORD = sky`. D6 range 37.54 to
38.49 arcsec^2, median 37.94. 16.7 MB per file, 53 s to download. Indexed with WCS key `A` of each
cutout. Fallback: header `OMEGA_MEDIAN`.

## External catalogs

- Gaia DR3 TAP at `https://gea.esac.esa.int/tap-server/tap/sync` (ADQL `gaiadr3.gaia_source`).
  `ref_epoch = 2016.0`. Radial velocity (`radial_velocity`) is used for propagation when present.
- CatWISE2020 is the IRSA table `catwise_2020`. `ra_pm`, `dec_pm` are the motion-fit position at
  MJD 57170 (J2015.402) and are the reference position used with the motion; `ra`, `dec` are a
  stationary fit that only approximately corresponds to the per-source `meanobsmjd` (about 1 arcsec
  off the motion fit for WISE 0855) and are used only when the motion fit is missing;
  `pmra`, `pmdec` are in arcsec/yr and already include cos(dec);
  `sigpmra`, `sigpmdec`, `par_pm`, `w1mpro`, `w2mpro`, `pmcode` are available.
- JPL SBIdent: `https://ssd-api.jpl.nasa.gov/sb_ident.api` accepts `obs-time=YYYY-MM-DD_hh:mm:ss`,
  `mpc-code=500` (geocentric), `sb-kind=a`, `fov-ra-center=HH-MM-SS`,
  `fov-dec-center=+DD-MM-SS`, half widths in degrees and `vmag-lim`. The service returned
  intermittent HTTP 500, so the client retries and caches.

## Reference astrometry of the five targets (pinned in data/targets.yaml)

| Target | Source | Reference epoch | Notes |
|---|---|---|---|
| Barnard's Star | Gaia DR3 4472832130942575872 | J2016.0 | pm (-801.551, +10362.394) mas/yr, parallax 546.976 mas, RV -110.47 km/s |
| WISE 0855-0714 | CatWISE2020 J085507.96-071439.3 | MJD 57338.571 (about 2015.86) | pm (-8021, +1036) mas/yr with 89 and 141 mas/yr errors; parallax 449 mas is approximate and unverified (see below) |
| Epsilon Indi B | Gaia DR3 6412596012146801152 | J2016.0 | Photocentre of the unresolved pair Ba/Bb; RUWE 4.3 from orbital motion |
| RW Aurigae | Gaia DR3 156430822114424576 (component A) | J2016.0 | Companion B is Gaia DR3 156430817820015232 about 1.5 arcsec away |
| R Draconis | Gaia DR3 1648328016354496384 | J2016.0 | 6 parameter solution; Mira photocentre makes the parallax uncertain |

WISE 0855: the challenge coordinates (08h55m10.831s, -07d14m42.53s) carry no epoch. Comparing them
with the CatWISE2020 position and its motion implies an epoch near 2010.5, about 5.3 years before
the CatWISE epoch, consistent with the WISE all-sky era. The CatWISE entry was selected as the
source with a proper motion of about 8 arcsec/yr within 0.06 deg of the challenge position. The
literature parallax and proper motion quoted in `docs/03` (449 mas, (-8118, +673) mas/yr) could not
be confirmed against a primary source here because CDS and journal hosts are unreachable; they are
stored with `verified: false` and used only as the validation reference, never as truth.
