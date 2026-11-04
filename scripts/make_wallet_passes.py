#!/usr/bin/env python3
"""Make one signed Apple Wallet pass (.pkpass) per guest.

    python3 scripts/make_wallet_passes.py \\
        --p12 ~/secrets/kt1121-pass.p12 --wwdr ~/secrets/AppleWWDRCAG4.cer \\
        --pass-type-id pass.net.peitzman.wedding --team-id ABCDE12345 [--upload]

Reads private/passes.json (written by scripts/import_passes.py) and writes
private/wallet/<zola_guest_id>.pkpass, one per guest: the boarding-pass style,
the gate, table, seat and destination from the workbook, the same PDF417
barcode (BCBP string) as the paper pass, and on the back a link to the
guest's own landing page (camera, songs, schedule).

Secrets never come from the repo:
  - the .p12's password: P12_PASSWORD, or a prompt;
  - for --upload: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the legacy
    service_role JWT, from Project Settings -> API keys) in the environment.
    Without --upload, copy the files with the Supabase CLI instead:
    supabase storage cp -r private/wallet ss:///wallet --experimental --linked

How to get the .p12, the WWDR certificate, the Pass Type ID and the Team ID:
docs/wallet.md. Needs: pip install -r scripts/requirements.txt
"""
import argparse
import getpass
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.serialization import Encoding, pkcs7, pkcs12
    from cryptography.x509.oid import NameOID
    from PIL import Image
except ImportError:
    sys.exit("Needs: pip install -r scripts/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "private"
CREST = ROOT / "site" / "assets" / "img" / "crest-cobalt.webp"
SITE = "https://wedding.peitzman.net"

# The flight, the same for every guest (the workbook's PRINT MERGE tab).
FLIGHT = "KT 1121"
ORIGIN, ORIGIN_CITY = "LGB", "Long Beach"
BOARDING = "7:00 PM"
DATE = "Saturday, November 21, 2026"
VENUE = "The Linden Club, 3636 Linden Ave, Long Beach, CA 90807"

# Design-system colors (Terrace theme): surface, cobalt text, muted labels.
COLORS = {
    "backgroundColor": "rgb(251, 251, 251)",
    "foregroundColor": "rgb(31, 81, 160)",
    "labelColor": "rgb(74, 95, 134)",
}


def pass_json(guest, pass_type_id, team_id):
    """pass.json for one guest."""
    city = guest.get("destination_city") or ""
    back = []
    if guest.get("ssr_remarks"):
        back.append({"key": "remarks", "label": "SSR · REMARKS", "value": guest["ssr_remarks"]})
    link = f"{SITE}/p/?pass={guest['token']}"
    back += [
        {"key": "tonight", "label": "TONIGHT", "value": link,
         "attributedValue": f"<a href='{link}'>Your camera, song requests and the schedule</a>"},
        {"key": "when", "label": "DATE", "value": DATE},
        {"key": "where", "label": "VENUE", "value": VENUE},
    ]
    return {
        "formatVersion": 1,
        "passTypeIdentifier": pass_type_id,
        "teamIdentifier": team_id,
        "serialNumber": guest["zola_guest_id"],
        "organizationName": "Katarina & Trevor",
        "description": f"Boarding pass, flight {FLIGHT}",
        "logoText": "K & T Airways",
        **COLORS,
        "boardingPass": {
            "transitType": "PKTransitTypeAir",
            "headerFields": [{"key": "gate", "label": "GATE", "value": guest.get("gate") or "—"}],
            "primaryFields": [
                {"key": "origin", "label": ORIGIN_CITY.upper(), "value": ORIGIN},
                {"key": "destination", "label": city.upper(), "value": guest.get("destination_code") or ""},
            ],
            "secondaryFields": [
                {"key": "passenger", "label": "PASSENGER", "value": guest.get("pass_name") or ""},
                {"key": "table", "label": "TABLE", "value": str(guest.get("table_number") or "—"),
                 "textAlignment": "PKTextAlignmentRight"},
            ],
            "auxiliaryFields": [
                {"key": "boarding", "label": "BOARDING", "value": BOARDING},
                {"key": "flight", "label": "FLIGHT", "value": FLIGHT},
                {"key": "seat", "label": "SEAT", "value": guest.get("seat") or "—"},
                {"key": "class", "label": "CLASS", "value": guest.get("cabin") or "—"},
            ],
            "backFields": back,
        },
        "barcodes": [{
            "format": "PKBarcodeFormatPDF417",
            "message": guest["bcbp"],
            "messageEncoding": "iso-8859-1",
        }],
    }


def images():
    """icon (required) and logo PNGs at 1x/2x/3x, from the crest."""
    crest = Image.open(CREST).convert("RGBA")
    out = {}

    def png(img):
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue()

    for scale, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        side = 29 * scale  # icon: square, crest centred on white
        icon = Image.new("RGBA", (side, side), (255, 255, 255, 255))
        c = crest.copy()
        c.thumbnail((side - 2 * scale, side - 2 * scale), Image.LANCZOS)
        icon.alpha_composite(c, ((side - c.width) // 2, (side - c.height) // 2))
        out[f"icon{suffix}.png"] = png(icon)

        c = crest.copy()  # logo: up to 160x50 points
        c.thumbnail((160 * scale, 50 * scale), Image.LANCZOS)
        out[f"logo{suffix}.png"] = png(c)
    return out


def load_signer(p12_path, password, wwdr_path):
    key, cert, _ = pkcs12.load_key_and_certificates(Path(p12_path).read_bytes(), password)
    if key is None or cert is None:
        sys.exit(f"{p12_path} must hold the Pass Type ID certificate and its private key.")
    raw = Path(wwdr_path).read_bytes()
    wwdr = x509.load_pem_x509_certificate(raw) if b"BEGIN CERTIFICATE" in raw else x509.load_der_x509_certificate(raw)
    return key, cert, wwdr


def check_cert(cert, pass_type_id, team_id):
    """The certificate names its Pass Type ID (UID) and Team ID (OU)."""
    def attr(oid):
        values = cert.subject.get_attributes_for_oid(oid)
        return values[0].value if values else None
    uid, ou = attr(NameOID.USER_ID), attr(NameOID.ORGANIZATIONAL_UNIT_NAME)
    problems = []
    if uid and uid != pass_type_id:
        problems.append(f"certificate is for {uid}, not --pass-type-id {pass_type_id}")
    if ou and ou != team_id:
        problems.append(f"certificate's team is {ou}, not --team-id {team_id}")
    return problems


def build(guest, pass_type_id, team_id, signer, imgs):
    key, cert, wwdr = signer
    files = {"pass.json": json.dumps(pass_json(guest, pass_type_id, team_id), ensure_ascii=False, indent=1).encode()}
    files.update(imgs)
    manifest = json.dumps({n: hashlib.sha1(b).hexdigest() for n, b in sorted(files.items())}, indent=1).encode()
    signature = (pkcs7.PKCS7SignatureBuilder()
                 .set_data(manifest)
                 .add_signer(cert, key, hashes.SHA256())
                 .add_certificate(wwdr)
                 .sign(Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature, pkcs7.PKCS7Options.Binary]))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(files.items()):
            z.writestr(name, data)
        z.writestr("manifest.json", manifest)
        z.writestr("signature", signature)
    return buf.getvalue()


def upload(url, service_key, name, data):
    req = urllib.request.Request(
        f"{url.rstrip('/')}/storage/v1/object/wallet/{name}", data=data, method="POST",
        headers={"Authorization": f"Bearer {service_key}", "apikey": service_key,
                 "Content-Type": "application/vnd.apple.pkpass", "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--p12", required=True, help="Pass Type ID certificate + private key, exported from Keychain")
    ap.add_argument("--wwdr", required=True, help="Apple WWDR intermediate certificate, G4 (.cer or .pem)")
    ap.add_argument("--pass-type-id", required=True, help="e.g. pass.net.peitzman.wedding")
    ap.add_argument("--team-id", required=True, help="10 characters, from Membership details")
    ap.add_argument("--passes", default=str(PRIVATE / "passes.json"))
    ap.add_argument("--out", default=str(PRIVATE / "wallet"))
    ap.add_argument("--only", help="make just this zola_guest_id (for a test on your own phone)")
    ap.add_argument("--upload", action="store_true", help="also upload to the private wallet bucket")
    args = ap.parse_args(argv)

    password = os.environ.get("P12_PASSWORD")
    if password is None:
        password = getpass.getpass(f"Password for {args.p12}: ")
    signer = load_signer(args.p12, password.encode() if password else None, args.wwdr)
    problems = check_cert(signer[1], args.pass_type_id, args.team_id)
    if problems:
        sys.exit("Wallet would refuse these passes:\n  " + "\n  ".join(problems))

    guests = json.loads(Path(args.passes).read_text())
    if args.only:
        guests = [g for g in guests if g.get("zola_guest_id") == args.only]
        if not guests:
            sys.exit(f"No guest with zola_guest_id {args.only} in {args.passes}")
    missing = [g.get("pass_name") or g.get("token") for g in guests if not (g.get("zola_guest_id") and g.get("bcbp"))]
    if missing:
        sys.exit("Missing zola_guest_id or bcbp for: " + ", ".join(map(str, missing)))

    url, service_key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if args.upload and not (url and service_key):
        sys.exit("--upload needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    imgs = images()
    failed = 0
    for g in guests:
        name = f"{g['zola_guest_id']}.pkpass"
        data = build(g, args.pass_type_id, args.team_id, signer, imgs)
        (out / name).write_bytes(data)
        if args.upload:
            try:
                upload(url, service_key, name, data)
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"  upload failed for {g.get('pass_name')}: {e.code} {e.read()[:200]!r}")
    print(f"{len(guests)} passes -> {out}/" + (f", uploaded {len(guests) - failed}" if args.upload else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
