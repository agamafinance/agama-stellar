"""Rebuild a RedStone payload from the gateway's signed packages.

The gateway hands back packages as JSON: a value, a timestamp, a signer and a
signature. What our oracle wants on chain is the bytes those signatures were
made over. So this reassembles them, exactly, and then checks its own work by
recovering each signer from the bytes it just built and comparing to the
address the gateway named. If a single byte of the layout were wrong the
recovery would land on a different address, which makes the check worth more
than a unit test: it is the same arithmetic the contract does.

The layout, read from the end, is the one the contract parses:

    payload = [pkg_1..pkg_N][package count 2B][metadata][metadata size 3B]
              [marker 9B = 0x000002ed57011e0000]
    pkg     = [point_1..point_M][timestamp 6B ms][value size 4B]
              [point count 3B][signature 65B]
    point   = [feed id 32B right-padded ASCII][value 32B big endian]

Values are integers at eight decimals, which is RedStone's default and not
negotiable: it is what the signature covers.
"""

import json
import urllib.request

from eth_keys import keys
from eth_utils import keccak

GATEWAYS = [
    "https://oracle-gateway-1.a.redstone.finance",
    "https://oracle-gateway-2.a.redstone.finance",
]
SERVICE = "redstone-primary-prod"
DECIMALS = 8
VALUE_BYTES = 32
MARKER = bytes.fromhex("000002ed57011e0000")


def fetch(service=SERVICE, timeout=30):
    """The latest packages for every feed, from whichever gateway answers."""
    last = None
    for base in GATEWAYS:
        url = f"{base}/data-packages/latest/{service}"
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - any failure means try the next
            last = e
    raise RuntimeError(f"no gateway answered: {last}")


def feed_id(name):
    """A feed id is its ASCII name, right-padded to 32 bytes with zeros."""
    raw = name.encode()
    if len(raw) > 32:
        raise ValueError(f"feed name too long for 32 bytes: {name}")
    return raw.ljust(32, b"\0")


def to_fixed(value):
    """A float from JSON into the integer the signature covers."""
    return int(round(float(value) * 10**DECIMALS))


def package_bytes(pkg):
    """The bytes a signer signed, and the signature that goes after them."""
    points = b""
    for dp in pkg["dataPoints"]:
        points += feed_id(dp["dataFeedId"])
        points += to_fixed(dp["value"]).to_bytes(VALUE_BYTES, "big")

    body = (
        points
        + int(pkg["timestampMilliseconds"]).to_bytes(6, "big")
        + VALUE_BYTES.to_bytes(4, "big")
        + len(pkg["dataPoints"]).to_bytes(3, "big")
    )
    sig = bytes.fromhex(pkg["signature"]) if _is_hex(pkg["signature"]) else _b64(pkg["signature"])
    if len(sig) != 65:
        raise ValueError(f"signature is {len(sig)} bytes, expected 65")
    return body, sig


def _is_hex(s):
    t = s[2:] if s.startswith("0x") else s
    try:
        bytes.fromhex(t)
        return True
    except ValueError:
        return False


def _b64(s):
    import base64

    return base64.b64decode(s)


def recovered_signer(body, sig):
    """Who signed these bytes, as a lowercase hex address without 0x."""
    digest = keccak(body)
    v = sig[64]
    rec = v - 27 if v >= 27 else v
    signature = keys.Signature(vrs=(rec, int.from_bytes(sig[0:32], "big"),
                                    int.from_bytes(sig[32:64], "big")))
    pub = signature.recover_public_key_from_msg_hash(digest)
    return pub.to_canonical_address().hex()


def build(packages, verify=True):
    """One payload carrying every package given, newest layout, hex encoded."""
    blobs = []
    for pkg in packages:
        body, sig = package_bytes(pkg)
        if verify:
            got = recovered_signer(body, sig)
            want = pkg["signerAddress"].lower().removeprefix("0x")
            if got != want:
                raise ValueError(
                    f"rebuilt bytes recover to {got}, gateway said {want} "
                    f"for {pkg.get('dataPackageId')}"
                )
        blobs.append(body + sig)

    metadata = b""  # RedStone allows it empty, and empty is one less thing signed
    payload = (
        b"".join(blobs)
        + len(blobs).to_bytes(2, "big")
        + metadata
        + len(metadata).to_bytes(3, "big")
        + MARKER
    )
    return payload.hex()


def packages_for(data, names):
    """Every signer's package for each feed named, flattened."""
    out = []
    missing = []
    for n in names:
        got = data.get(n)
        if not got:
            missing.append(n)
            continue
        out.extend(got)
    return out, missing
