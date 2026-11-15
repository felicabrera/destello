import httpx
import pytest
import respx

from destello.core.egress import EgressClient, EgressError, check_url

ALLOW = frozenset({"irsa.ipac.caltech.edu", "gea.esac.esa.int"})


def test_check_url_rules() -> None:
    check_url("https://irsa.ipac.caltech.edu/TAP", ALLOW)
    for bad in [
        "http://irsa.ipac.caltech.edu/TAP",
        "https://evil.example/x",
        "https://irsa.ipac.caltech.edu.evil.example/",
        "https://user:pw@irsa.ipac.caltech.edu/",
        "file:///etc/passwd",
        "https://127.0.0.1/",
        "https://169.254.169.254/latest/meta-data",
    ]:
        with pytest.raises(EgressError):
            check_url(bad, ALLOW)


@respx.mock
async def test_redirect_to_allowlisted_host_is_followed() -> None:
    respx.get("https://irsa.ipac.caltech.edu/a").mock(
        return_value=httpx.Response(302, headers={"location": "https://gea.esac.esa.int/b"})
    )
    respx.get("https://gea.esac.esa.int/b").mock(return_value=httpx.Response(200, text="ok"))
    async with EgressClient(ALLOW) as c:
        r = await c.get("https://irsa.ipac.caltech.edu/a")
    assert r.text == "ok"


@respx.mock
async def test_redirect_to_other_host_is_blocked() -> None:
    respx.get("https://irsa.ipac.caltech.edu/a").mock(
        return_value=httpx.Response(302, headers={"location": "https://evil.example/b"})
    )
    async with EgressClient(ALLOW) as c:
        with pytest.raises(EgressError):
            await c.get("https://irsa.ipac.caltech.edu/a")


@respx.mock
async def test_redirect_downgrade_to_http_is_blocked() -> None:
    respx.get("https://irsa.ipac.caltech.edu/a").mock(
        return_value=httpx.Response(301, headers={"location": "http://irsa.ipac.caltech.edu/b"})
    )
    async with EgressClient(ALLOW) as c:
        with pytest.raises(EgressError):
            await c.get("https://irsa.ipac.caltech.edu/a")


@respx.mock
async def test_see_other_after_post_is_followed_with_get() -> None:
    respx.post("https://irsa.ipac.caltech.edu/sync").mock(
        return_value=httpx.Response(
            303, headers={"location": "https://irsa.ipac.caltech.edu/sync/1/run"}
        )
    )
    done = respx.get("https://irsa.ipac.caltech.edu/sync/1/run").mock(
        return_value=httpx.Response(200, text="rows")
    )
    async with EgressClient(ALLOW) as c:
        r = await c.post("https://irsa.ipac.caltech.edu/sync", data={"QUERY": "x"})
    assert r.text == "rows" and done.called
