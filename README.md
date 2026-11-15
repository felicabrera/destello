# Destello

**Watch the infrared sky move. / Mira cómo se mueve el cielo infrarrojo.**

Destello is a public, bilingual (English and Spanish) web tool that turns NASA SPHEREx all-sky infrared images into short time-lapse animations of any patch of sky. Anyone can enter coordinates or an object name, watch how that patch changes between survey epochs, and spot moving or changing objects: nearby stars, brown dwarfs, asteroids, comets and variable stars.

Destello is the entry of Felipe Cabrera for the **NASA Space Apps Challenge 2026** (Montevideo local event), challenge **"Planet X and SPHEREx"**.

The name: *destello* is Spanish for "flash" or "glint", the brief spark of light that betrays something moving in the sky. It is pronounced *des-TEH-yo* and is easy to say in English and Spanish.

---

## Status

| Item | Value |
|---|---|
| Phase | Deployed at https://destello.felicabrera.com |
| Last updated | 2026-11-15 |
| Event weekend | 2026-11-14 to 2026-11-15 |
| Owner | Felipe Cabrera |

### Validation results

`data/validation.json` (generated 2026-11-15 13:35 local time, 2026-11-15T16:35:32Z, by `scripts/run_validation.py`, pipeline 0.3.0) holds 28 rows for V-01 to V-15: 24 pass, 2 fail and 2 are not measurable. Two rows changed on 2026-11-15. V-15 for Barnard's Star passes with its WISE companion sequence (10372.7 mas/yr against 10398.6 from Gaia DR3, 1.4 sigma per axis; the fit does not recover the parallax, see docs/11). V-13 for the August 2025 campaign of 3I/ATLAS passes after an estimator correction: the code required each continuum window at 3 sigma, which the registered difference test does not ask for. The CO2 band is 88.4 +/- 13.5 mJy against a continuum of 1.0 +/- 0.4 mJy that is not detected, 6.5 sigma; no band to continuum ratio is reported. The correction was written after the window values were known, and docs/11 gives both results. The data are the five presets and the two 3I/ATLAS campaigns rebuilt on SPHEREx Data Release 1 (DR1, DOI 10.26131/IRSA678), with Quick Release 3 for the newest epochs. No tolerance was changed. V-16 (NEOSSat) was not attempted. The protocol and tolerances are in [docs/11](docs/11-testing-and-validation.md); the cause analysis is recorded there under "Results on DR1 (2026-11-14)". History: the build of 2026-11-12 on Quick Release 2 and 3 passed 22 of 22 checks.

Failures:

- V-10 RW Aurigae: one unexplained dipole (lobes +8.0 and -10.5 sigma) on the wing of the G 11.88 star Gaia DR3 156429997483589120, 9.6 arcsec away, whose core overflows in a few exposures; rebuilding the first epoch from the Quick Release 2 cutouts gives no dipole, so the DR1 pixel values changed.
- V-14 comet August 2025: 43 of 63 measured exposures within the bound (median offset 1.75 arcsec, maximum 20.3 arcsec); the 20 failing exposures sit in 14 observations and the offset behaves like a fixed sky source, so field stars in the fit box are the probable cause. December 2025 passes (103 of 103).

Not measurable:

- V-12 Epsilon Indi B: DR1 defines a new HALO flag bit, set on 1 to 4 core pixels at the target and part of the photometry mask, so the first epoch keeps 1 of its 3 points in the band window (2 are needed). The earlier 0.424 is the Quick Release 2 value.
- V-13 3I/ATLAS CO2 band, December 2025: 1 point in the band window (2 are needed), because the exposures of that pass step 0.036 um. No detection is claimed for December.

| Check | Target | Destello | Reference | Result |
|---|---|---|---|---|
| V-02 proper motion | Barnard's Star | 10351.9 +/- 598.4 mas/yr | 10393.3 mas/yr (Gaia DR3) | pass, 0.4 sigma |
| V-03 proper motion | WISE 0855-0714 (2 epochs) | 8680.8 +/- 1338.8 mas/yr | 8087.8 mas/yr (CatWISE2020) | pass, 1.1 sigma |
| V-04 proper motion | Epsilon Indi B (unresolved pair) | 4575.5 +/- 211.0 mas/yr | 4684.2 mas/yr (Gaia DR3) | pass, 0.5 sigma |
| V-11 blind motion search | Epsilon Indi B | 4643.9 +/- 148.1 mas/yr | 4684.2 mas/yr (Gaia DR3) | pass, 0.3 sigma |
| V-15 long baseline (WISE/NEOWISE and SPHEREx) | WISE 0855-0714 | 8157.8 +/- 15.7 mas/yr | 8087.8 mas/yr (CatWISE2020, not independent) | pass, 2.5 sigma (worst axis) |
| V-15 long baseline (WISE/NEOWISE and SPHEREx) | Barnard's Star | 10372.7 +/- 17.5 mas/yr | 10398.6 mas/yr (Gaia DR3 at the fit epoch) | pass, 1.4 sigma (worst axis); reduced chi-square 6.2 and the parallax is not recovered |
| V-06 variability | R Draconis | 0.302 +/- 0.020 mag between epochs | change expected (Mira variable) | pass, 15.4 sigma |
| V-07 variability | RW Aurigae | 0.378 +/- 0.011 mag between epochs 1 and 2 (largest pair) | change expected | pass by the stated-result rule: the detectors disagree in sign (D1 to D3 brighter, D5 and D6 fainter), so no consistent change is claimed |
| V-08 flux scale | Field stars against 2MASS | -7.6 +/- 2.8 percent | within 10 percent per band | pass |
| V-09 null test | Stationary field star near Barnard's Star | 123.4 +/- 147.8 mas/yr | 4.8 mas/yr (Gaia DR3) | pass, 0.8 sigma |
| V-01, V-05 astrometry | All presets | recalibration residuals 0.14 to 0.28 arcsec; position offsets 0.67 to 4.06 arcsec | below 1 arcsec; within 6.2 arcsec | pass |
| V-10 difference images | Barnard's Star, Epsilon Indi B, R Draconis, WISE 0855 | 0 unexplained dipoles | 0 | pass |
| V-10 difference images | RW Aurigae | 1 unexplained dipole | 0 | fail |
| V-14 coma centroid | 3I/ATLAS, August 2025 | 43 of 63 within the bound | at least 90 percent | fail |
| V-14 coma centroid | 3I/ATLAS, December 2025 | 103 of 103 within the bound | at least 90 percent | pass |
| V-12 methane index | Epsilon Indi B | not measurable | below the field stars | not measurable |
| V-13 CO2 band | 3I/ATLAS, August 2025 | band 88.4 +/- 13.5 mJy, continuum not detected, 6.5 sigma | band above the continuum by more than 3 sigma | pass |
| V-13 CO2 band | 3I/ATLAS, December 2025 | not measurable | band above the continuum | not measurable |

For V-15 on WISE 0855, the proper motion in declination agrees with the reference only because the CatWISE2020 error is large, and CatWISE2020 is built from WISE data, so the comparison is a consistency check. The WISE epochs of 2010 to 2011 are missing because IRSA TAP did not answer.

Data note (2026-11-14): IRSA replaced Quick Release 2 with DR1 on 2026-11-12 and removed `spherex_qr2` from its TAP service. The backend queries `spherex_dr1`, `spherex_qr3` and their deep variants.

### Running locally

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node.js 22 or later with pnpm.

```bash
# Backend: dependencies and gates
cd backend
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy src
uv run pytest

# Frontend: dependencies, gates and the production build served by the stack
cd ../frontend
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build

# Full stack on http://127.0.0.1:8080 (Caddy, API, worker, Redis)
cd ..
docker compose -f deploy/docker-compose.yml up -d --build

# Build the five preset sequences (live IRSA and S3) when data/ is empty
cd backend && uv run python ../scripts/warm_targets.py
```

The acceptance script runs against the stack with `ACCEPTANCE_URL=http://127.0.0.1:8080 pnpm exec playwright test acceptance` in `frontend/`.

## Project at a glance

| Aspect | Decision |
|---|---|
| Challenge | Planet X and SPHEREx (NASA Space Apps Challenge 2026) |
| Ambition | 2026 Global Winner |
| Primary award target | Best Use of Data |
| Secondary award targets | Best Use of Science, Best Use of Technology |
| Core experience | Enter coordinates or a name, see SPHEREx epochs as a blink animation, compare, measure, report |
| Key differentiator | Quantitative validation: Destello measures the motion of known stars in SPHEREx images and compares it with published values |
| Backend | Python 3.12, FastAPI, arq workers, astropy, astroquery, pyvo, photutils, reproject |
| Frontend | React, TypeScript, Vite, TanStack Router and Query, Tailwind CSS, Aladin Lite v3, Plotly |
| Data | NASA/IPAC IRSA SPHEREx Data Release 1 and Quick Release 3 (SIA2, TAP, cutouts), Gaia DR3, CatWISE2020, SIMBAD, JPL SBIdent |
| Infrastructure | Docker Compose, Caddy, Redis, a web application firewall, Cloudflare, GitHub Actions |
| Languages | English and Spanish (full UI parity) |
| License | MIT for code; data under the terms of each provider |

## Guiding principles

1. **Challenge compliance first.** Every stated objective works on all five named test targets before any extra is built.
2. **Correct before clever.** Positions are propagated to the observation epoch, intensities share a stretch across epochs, and every frame is traceable to its source images.
3. **Deployed beats local.** Judges review asynchronously; a stable public URL with a static fallback is mandatory.
4. **Honest about limits.** Resolution, epoch count and calibration limits are shown in the interface, not hidden.
5. **Open to everyone.** Bilingual, keyboard operable, colorblind safe, embeddable.

## Running, deploying and checking

| Task | Where |
|---|---|
| Local stack (Docker Compose) | `deploy/docker-compose.yml`, `backend/README.md` |
| Production deployment (Docker Compose behind a web application firewall and Cloudflare) | `.github/workflows/deploy.yml`, `deploy/docker-compose.prod.yml`, `deploy/Caddyfile.prod`, `deploy/env.example`; host specific configuration is kept outside this repository |
| Static demo bundle | `python scripts/export_demo.py` writes `demo/` (generated, not tracked) |
| Design placeholder and secret check | `python scripts/check_placeholders.py` (exit 1 on violations; also run in CI) |
| Continuous integration | `.github/workflows/` (ci, e2e, security, deploy), `.github/dependabot.yml` |
| API types from OpenAPI | `scripts/gen_api_types.sh` |

## License and data terms

Destello is released under the MIT License ([LICENSE](LICENSE)). SPHEREx data are served by NASA/IPAC IRSA, and Gaia, CatWISE2020, SIMBAD and JPL data remain under each provider's own terms and citation requirements.
