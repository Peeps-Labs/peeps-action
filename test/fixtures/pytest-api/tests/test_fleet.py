import asyncio
import os

import httpx
import requests


def test_work_order_is_queued(fleet_url):
    response = requests.post(
        f"{fleet_url}/work-orders",
        json={"robotId": "RR-C20-0007", "task": "Recalibrate lidar", "password": "hunter2"},
        headers={"Authorization": "Bearer abc.def.ghi"},
    )
    assert response.status_code == 201
    assert response.json()["status"] == "queued"


def test_lists_robots(fleet_url):
    # Passes: a passing test reports no calls.
    assert httpx.get(f"{fleet_url}/robots").status_code == 200


def test_secret_never_leaves(fleet_url):
    token = os.environ["FLEET_TOKEN"]
    with httpx.Client() as client:
        client.get(f"{fleet_url}/robots?api_key=k-123&page=2", headers={"X-Fleet-Echo": token})
    response = asyncio.run(_robots(f"{fleet_url}/robots"))
    assert response.json()["items"], "the fleet is empty"


async def _robots(url):
    async with httpx.AsyncClient() as client:
        return await client.get(url)


def test_api_down():
    requests.get("http://127.0.0.1:9/robots", timeout=2)
