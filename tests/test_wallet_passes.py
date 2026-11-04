#!/usr/bin/env python3
"""Tests for scripts/make_wallet_passes.py, with a throwaway certificate chain.

    python3 tests/test_wallet_passes.py

Makes a fake "WWDR" CA and a Pass Type ID certificate shaped like Apple's
(UID = pass type ID, OU = team ID), signs passes for two fake guests, then
checks the zip, the manifest hashes, pass.json, and that `openssl` verifies
the detached signature against the manifest. Apple's real chain can only be
tested on a phone; see docs/wallet.md.
"""
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs12  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

import make_wallet_passes as mwp  # noqa: E402

PASS_TYPE, TEAM = "pass.test.kt1121", "TEAMID1234"
GUESTS = [
    {"token": "TestTokenAAAAAAAA", "zola_guest_id": "zola-test-1", "first_name": "Dora", "last_name": "Day",
     "pass_name": "DAY/DORA", "strip_name": "DORA D.", "table_number": 5, "gate": "P05",
     "destination_city": "Santorini", "destination_code": "JTR", "cabin": "F", "seat": "005A", "seq": 1,
     "pnr": "ABC123", "ssr_remarks": "Met at a ferry terminal.",
     "bcbp": "M1DAY/DORA            EABC123 LGBJTRKT 1121 325F005A0001 000"},
    {"token": "TestTokenBBBBBBBB", "zola_guest_id": "zola-test-2", "first_name": "Eli", "last_name": "Ever",
     "pass_name": "EVER/ELI", "strip_name": "ELI E.", "table_number": 13, "gate": "P13",
     "destination_city": "Budapest", "destination_code": "BUD", "cabin": "F", "seat": "013A", "seq": 2,
     "pnr": "XYZ789", "ssr_remarks": None,
     "bcbp": "M1EVER/ELI            EXYZ789 LGBBUDKT 1121 325F013A0002 000"},
]

failures = 0


def check(ok, what):
    global failures
    print(("ok - " if ok else "FAIL: ") + what)
    if not ok:
        failures += 1


def make_chain(tmp):
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test WWDR CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(1).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=2))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .sign(ca_key, hashes.SHA256()))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.USER_ID, PASS_TYPE),
        x509.NameAttribute(NameOID.COMMON_NAME, f"Pass Type ID: {PASS_TYPE}"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM),
    ])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca_name).public_key(key.public_key())
            .serial_number(2).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=1))
            .sign(ca_key, hashes.SHA256()))
    p12 = pkcs12.serialize_key_and_certificates(b"pass", key, cert, None,
                                                serialization.BestAvailableEncryption(b"secret"))
    (tmp / "pass.p12").write_bytes(p12)
    (tmp / "wwdr.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (tmp / "wwdr.der").write_bytes(ca.public_bytes(serialization.Encoding.DER))


def main():
    tmp = Path(tempfile.mkdtemp())
    try:
        make_chain(tmp)
        (tmp / "passes.json").write_text(json.dumps(GUESTS))
        import os
        os.environ["P12_PASSWORD"] = "secret"

        # Wrong pass type ID: refused before anything is written.
        try:
            mwp.main(["--p12", str(tmp / "pass.p12"), "--wwdr", str(tmp / "wwdr.der"),
                      "--pass-type-id", "pass.other.id", "--team-id", TEAM,
                      "--passes", str(tmp / "passes.json"), "--out", str(tmp / "bad")])
            check(False, "wrong pass type ID refused")
        except SystemExit as e:
            check("certificate is for" in str(e) and not (tmp / "bad").exists(), "wrong pass type ID refused")

        rc = mwp.main(["--p12", str(tmp / "pass.p12"), "--wwdr", str(tmp / "wwdr.der"),
                       "--pass-type-id", PASS_TYPE, "--team-id", TEAM,
                       "--passes", str(tmp / "passes.json"), "--out", str(tmp / "wallet")])
        check(rc == 0, "generator ran")
        files = sorted(p.name for p in (tmp / "wallet").iterdir())
        check(files == ["zola-test-1.pkpass", "zola-test-2.pkpass"], "one .pkpass per guest, named by Zola ID")

        z = zipfile.ZipFile(tmp / "wallet" / "zola-test-1.pkpass")
        names = set(z.namelist())
        need = {"pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "icon@3x.png",
                "logo.png", "logo@2x.png", "logo@3x.png"}
        check(need <= names, "zip has pass.json, manifest, signature, icon and logo at 1x/2x/3x")

        manifest = json.loads(z.read("manifest.json"))
        check(set(manifest) == names - {"manifest.json", "signature"}, "manifest lists every other file")
        check(all(hashlib.sha1(z.read(n)).hexdigest() == h for n, h in manifest.items()), "manifest SHA-1s match")

        p = json.loads(z.read("pass.json"))
        bp = p["boardingPass"]
        check(p["passTypeIdentifier"] == PASS_TYPE and p["teamIdentifier"] == TEAM, "pass type and team IDs")
        check(p["serialNumber"] == "zola-test-1" and p["formatVersion"] == 1, "serial is the Zola ID")
        check(bp["transitType"] == "PKTransitTypeAir", "boarding pass, air")
        check(bp["headerFields"][0]["value"] == "P05", "gate in the header")
        check([f["value"] for f in bp["primaryFields"]] == ["LGB", "JTR"], "LGB to the guest's destination")
        check(p["barcodes"][0]["format"] == "PKBarcodeFormatPDF417" and
              p["barcodes"][0]["message"] == GUESTS[0]["bcbp"], "PDF417 carries the paper pass's BCBP string")
        tonight = [f for f in bp["backFields"] if f["key"] == "tonight"][0]
        check(tonight["value"].endswith("/p/?pass=TestTokenAAAAAAAA"), "back links to the guest's own landing page")
        p2 = json.loads(zipfile.ZipFile(tmp / "wallet" / "zola-test-2.pkpass").read("pass.json"))
        check(not any(f["key"] == "remarks" for f in p2["boardingPass"]["backFields"]), "no empty remarks field")

        # The detached PKCS#7 signature verifies against manifest.json.
        (tmp / "manifest.json").write_bytes(z.read("manifest.json"))
        (tmp / "signature").write_bytes(z.read("signature"))
        r = subprocess.run(["openssl", "smime", "-verify", "-inform", "DER", "-in", str(tmp / "signature"),
                            "-content", str(tmp / "manifest.json"), "-CAfile", str(tmp / "wwdr.pem"),
                            "-purpose", "any", "-binary", "-out", "/dev/null"], capture_output=True, text=True)
        check(r.returncode == 0, "openssl verifies the signature" + ("" if r.returncode == 0 else ": " + r.stderr.strip()))
        r = subprocess.run(["openssl", "pkcs7", "-inform", "DER", "-in", str(tmp / "signature"), "-print_certs"],
                           capture_output=True, text=True)
        check("Test WWDR CA" in r.stdout and PASS_TYPE in r.stdout, "signature carries the pass cert and the WWDR cert")

        # ...and fails against a manifest that was changed after signing.
        (tmp / "manifest.json").write_bytes(z.read("manifest.json").replace(b"pass.json", b"pass.jsoN"))
        r = subprocess.run(["openssl", "smime", "-verify", "-inform", "DER", "-in", str(tmp / "signature"),
                            "-content", str(tmp / "manifest.json"), "-CAfile", str(tmp / "wwdr.pem"),
                            "-purpose", "any", "-binary", "-out", "/dev/null"], capture_output=True, text=True)
        check(r.returncode != 0, "a changed manifest fails verification")

        # --only makes one pass.
        mwp.main(["--p12", str(tmp / "pass.p12"), "--wwdr", str(tmp / "wwdr.pem"),
                  "--pass-type-id", PASS_TYPE, "--team-id", TEAM, "--passes", str(tmp / "passes.json"),
                  "--out", str(tmp / "one"), "--only", "zola-test-2"])
        check(sorted(p.name for p in (tmp / "one").iterdir()) == ["zola-test-2.pkpass"], "--only makes one pass (PEM WWDR too)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("All wallet pass tests passed." if not failures else f"{failures} wallet pass test(s) failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
