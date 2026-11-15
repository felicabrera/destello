from destello.api.routes.meta import _not_measurable


def test_all_physical_tests_not_measurable() -> None:
    doc = {
        "tests": [
            {"id": "V-05", "target": "rdra", "status": "not_measurable"},
            {"id": "V-06", "target": "rdra", "status": "not_measurable"},
            {"id": "V-10", "target": "rdra", "status": "fail"},
        ]
    }
    assert _not_measurable("rdra", doc)


def test_one_measured_test_or_no_tests() -> None:
    doc = {
        "tests": [
            {"id": "V-05", "target": "rwaur", "status": "not_measurable"},
            {"id": "V-07", "target": "rwaur", "status": "pass"},
        ]
    }
    assert not _not_measurable("rwaur", doc)
    assert not _not_measurable("barnard", doc)
    assert not _not_measurable("rdra", None)
