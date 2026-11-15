"""Build estimate against measured full builds (3 epochs, 6 detectors): 369 images at 6 arcmin
(S3 and IRSA) and 427 images at 10 arcmin (S3, 1528 MB downloaded, 514 s wall time)."""

import pytest

from destello.api.routes.sequences import estimate_numbers

SUMMARY = {"used": 369, "epochs": 3, "detectors": 6}
SUMMARY_10 = {"used": 427, "epochs": 3, "detectors": 6}


def test_estimate_matches_measured_s3_build() -> None:
    est = estimate_numbers(SUMMARY, 6.0, "s3")
    assert est.images == 369
    assert est.seconds == pytest.approx(261.7, rel=0.06)
    assert est.megabytes == pytest.approx(840, rel=0.05)


def test_s3_estimate_grows_with_the_field() -> None:
    """S3 range reads fetch whole rows, so bytes scale with the cutout side."""
    est = estimate_numbers(SUMMARY_10, 10.0, "s3")
    assert est.megabytes == pytest.approx(1528 + 4, rel=0.05)
    assert est.seconds == pytest.approx(514, rel=0.06)


def test_estimate_matches_measured_irsa_build() -> None:
    est = estimate_numbers(SUMMARY, 6.0, "irsa")
    assert est.seconds == pytest.approx(492.0, rel=0.05)
    assert est.megabytes == pytest.approx(1468, rel=0.05)


def test_estimate_defaults_to_the_s3_source() -> None:
    assert estimate_numbers(SUMMARY, 6.0) == estimate_numbers(SUMMARY, 6.0, "s3")
