"""The business dashboard: clients across India, called in their language."""

from __future__ import annotations

import httpx

from friday_services.business_page import ClientBook, region_of

from .conftest import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_the_book_starts_with_examples_in_every_language_and_no_numbers(tmp_path):
    book = ClientBook(tmp_path / "clients.json")
    clients = book.all()
    assert {c["language"] for c in clients} >= {"ta-IN", "te-IN", "kn-IN", "mr-IN", "hi-IN"}
    assert all(c["phone"] == "" and c["example"] for c in clients)
    # Adding a number makes an example a real client.
    first = clients[0]
    saved = book.save({**first, "phone": "+91 98123 45678"}, first["id"])
    assert saved["phone"] == "+919812345678" and "example" not in saved
    assert book.get(first["id"])["phone"] == "+919812345678"
    assert book.remove(first["id"]) and not book.get(first["id"])


def test_regions_follow_the_city():
    assert region_of("Chennai") == "South"
    assert region_of("pune") == "West"
    assert region_of("Kolkata") == "East"
    assert region_of("Delhi") == "North"
    assert region_of("Atlantis") == "Other"


def test_the_dashboard_shows_clients_and_refuses_calls_it_cannot_make(server):
    base = server.url
    page = httpx.get(f"{base}/business", headers=AUTH).json()
    assert page["business"]["ready"] is False  # tests have no business profile
    assert len(page["clients"]) == 10 and page["clients"][0]["region"] == "South"
    assert page["languages"]["ta-IN"] == "Tamil"

    bad = httpx.post(f"{base}/business/clients", headers=AUTH, json={"name": "X", "phone": "123"})
    assert bad.status_code == 400 and "international" in bad.json()["detail"]
    added = httpx.post(
        f"{base}/business/clients",
        headers=AUTH,
        json={"name": "Kavya", "phone": "+919812345678", "city": "Mysuru", "language": "kn-IN"},
    ).json()
    shown = httpx.get(f"{base}/business", headers=AUTH).json()["clients"]
    assert any(c["id"] == added["id"] and c["region"] == "South" for c in shown)

    no_number = httpx.post(
        f"{base}/business/clients/{page['clients'][0]['id']}/call", headers=AUTH, json={}
    )
    assert no_number.status_code == 400 and "phone number" in no_number.json()["detail"]
    no_profile = httpx.post(f"{base}/business/clients/{added['id']}/call", headers=AUTH, json={})
    assert no_profile.status_code == 400 and "business profile" in no_profile.json()["detail"]
    assert httpx.get(f"{base}/business").status_code == 401
