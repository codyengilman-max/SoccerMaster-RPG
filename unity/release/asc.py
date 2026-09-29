#!/usr/bin/env python3
"""App Store Connect API client for the cloud-only iOS release path (no Mac, no fastlane, no Transporter).

Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8 (PEM text) — read only from the environment, never printed.
Optional: UNITY_BUILD_API_KEY / UNITY_ORG_ID / UNITY_PROJECT_ID for `uba-credentials`.

  asc.py check [bundle-id]                  read-only: bundle id, app record, distribution certs, App Store profiles
  asc.py register-bundle-id <id> <name>     POST /v1/bundleIds (IOS)
  asc.py signing <bundle-id> <out-dir>      create Apple Distribution cert + App Store profile; writes
                                            out-dir/cert.p12, p12.pass, appstore.mobileprovision (mode 0600)
  asc.py uba-credentials <out-dir> <label>  upload out-dir/{cert.p12,p12.pass,appstore.mobileprovision} to UBA
  asc.py upload <ipa> <bundle-id> <version> <build>   POST buildUploads → PUT parts → PATCH uploaded → wait COMPLETE
  asc.py build-status <bundle-id> <build>   processing state of the App Store Connect build record
  asc.py encryption <bundle-id> <build>     mark the build usesNonExemptEncryption=false (clears "Missing Compliance")
  asc.py distribute <bundle-id> <build> <group-name>   add the build to a TestFlight beta group
  asc.py groups <bundle-id>                 list beta groups
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import jwt  # PyJWT, ES256 via cryptography

API = "https://api.appstoreconnect.apple.com"
UBA_API = "https://build-api.cloud.unity3d.com/api/v1"
UBA_DEFAULT_PROJECT = "32575c1e-2193-4caf-ab3f-c6fd811b1f51"
DISTRIBUTION_TYPES = {"DISTRIBUTION", "IOS_DISTRIBUTION"}


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value.strip():
        sys.exit(f"missing env {name}")
    return value


_token_cache: tuple[float, str] | None = None


def token() -> str:
    global _token_cache
    now = time.time()
    if _token_cache and _token_cache[0] > now + 60:
        return _token_cache[1]
    key = env("ASC_API_KEY_P8").replace("\\n", "\n").strip() + "\n"
    exp = now + 15 * 60
    t = jwt.encode({"iss": env("ASC_ISSUER_ID"), "iat": int(now), "exp": int(exp), "aud": "appstoreconnect-v1"},
                   key, algorithm="ES256", headers={"kid": env("ASC_KEY_ID"), "typ": "JWT"})
    if isinstance(t, bytes):
        t = t.decode()
    _token_cache = (exp, t)
    return t


def api(method: str, path: str, body: dict | None = None, ok=(200, 201, 204)) -> dict | None:
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
            if resp.status not in ok:
                sys.exit(f"unexpected HTTP {resp.status} {method} {path}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.dumps(json.loads(detail).get("errors"), indent=2)
        except Exception:
            pass
        sys.exit(f"HTTP {e.code} {method} {path}\n{detail[:3000]}")
    return json.loads(payload) if payload else None


def one(items: list, what: str):
    if not items:
        sys.exit(f"not found: {what}")
    if len(items) > 1:
        print(f"note: {len(items)} matches for {what}; using the first", file=sys.stderr)
    return items[0]


def bundle_id_record(identifier: str) -> dict | None:
    res = api("GET", "/v1/bundleIds?" + urllib.parse.urlencode({"filter[identifier]": identifier, "filter[platform]": "IOS"}))
    exact = [b for b in res["data"] if b["attributes"]["identifier"] == identifier]
    return exact[0] if exact else None


def app_record(identifier: str) -> dict | None:
    res = api("GET", "/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": identifier}))
    exact = [a for a in res["data"] if a["attributes"]["bundleId"] == identifier]
    return exact[0] if exact else None


def dump(obj) -> None:
    print(json.dumps(obj, indent=2, sort_keys=True))


def write_private(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


# ---------------------------------------------------------------- commands

def cmd_check(bundle: str) -> None:
    b = bundle_id_record(bundle)
    a = app_record(bundle)
    certs = api("GET", "/v1/certificates?" + urllib.parse.urlencode({"filter[certificateType]": "DISTRIBUTION,IOS_DISTRIBUTION", "limit": 200}))["data"]
    profiles = api("GET", "/v1/profiles?" + urllib.parse.urlencode({"filter[profileType]": "IOS_APP_STORE", "limit": 200}))["data"]
    dump({
        "bundleId": {"registered": b is not None, "id": b and b["id"], "name": b and b["attributes"]["name"], "seedId": b and b["attributes"].get("seedId")},
        "app": {"exists": a is not None, "id": a and a["id"], "name": a and a["attributes"]["name"], "sku": a and a["attributes"].get("sku")},
        "distributionCertificates": [{"id": c["id"], "type": c["attributes"]["certificateType"], "name": c["attributes"]["name"],
                                      "expires": c["attributes"]["expirationDate"]} for c in certs],
        "appStoreProfiles": [{"id": p["id"], "name": p["attributes"]["name"], "state": p["attributes"]["profileState"],
                              "expires": p["attributes"]["expirationDate"]} for p in profiles],
    })


def cmd_register_bundle_id(identifier: str, name: str) -> None:
    existing = bundle_id_record(identifier)
    if existing:
        print("already registered", existing["id"])
        return
    res = api("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {"identifier": identifier, "name": name, "platform": "IOS"}}})
    dump({"id": res["data"]["id"], "identifier": res["data"]["attributes"]["identifier"], "seedId": res["data"]["attributes"].get("seedId")})


def cmd_signing(bundle: str, out_dir: str, cert_type: str = "IOS_DISTRIBUTION", profile_name: str = "SoccerMaster App Store") -> None:
    b = bundle_id_record(bundle)
    if not b:
        sys.exit(f"bundle id {bundle} is not registered; run register-bundle-id first")
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    key_pem = os.path.join(out_dir, "key.pem")
    csr_pem = os.path.join(out_dir, "req.csr")
    cert_pem = os.path.join(out_dir, "cert.pem")
    p12 = os.path.join(out_dir, "cert.p12")
    pass_file = os.path.join(out_dir, "p12.pass")
    profile_path = os.path.join(out_dir, "appstore.mobileprovision")

    subprocess.run(["openssl", "genrsa", "-out", key_pem, "2048"], check=True, capture_output=True)
    os.chmod(key_pem, 0o600)
    subprocess.run(["openssl", "req", "-new", "-key", key_pem, "-out", csr_pem, "-subj", "/CN=SoccerMaster CI/O=SoccerMaster/C=US"],
                   check=True, capture_output=True)
    csr = open(csr_pem).read()

    res = api("POST", "/v1/certificates", {"data": {"type": "certificates", "attributes": {"certificateType": cert_type, "csrContent": csr}}})
    cert = res["data"]
    der = base64.b64decode(cert["attributes"]["certificateContent"])
    subprocess.run(["openssl", "x509", "-inform", "DER", "-outform", "PEM", "-out", cert_pem], input=der, check=True, capture_output=True)
    password = secrets.token_urlsafe(24)
    write_private(pass_file, password.encode())
    subprocess.run(["openssl", "pkcs12", "-export", "-legacy", "-inkey", key_pem, "-in", cert_pem, "-out", p12,
                    "-passout", "file:" + pass_file, "-name", "Apple Distribution SoccerMaster"], check=True, capture_output=True)
    os.chmod(p12, 0o600)

    prof = api("POST", "/v1/profiles", {"data": {"type": "profiles",
        "attributes": {"name": profile_name + " " + time.strftime("%Y%m%d-%H%M"), "profileType": "IOS_APP_STORE"},
        "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": b["id"]}},
                          "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]}}}})["data"]
    write_private(profile_path, base64.b64decode(prof["attributes"]["profileContent"]))
    os.remove(csr_pem)
    dump({"certificate": {"id": cert["id"], "type": cert["attributes"]["certificateType"], "name": cert["attributes"]["name"],
                          "expires": cert["attributes"]["expirationDate"], "serial": cert["attributes"].get("serialNumber")},
          "profile": {"id": prof["id"], "name": prof["attributes"]["name"], "state": prof["attributes"]["profileState"],
                      "uuid": prof["attributes"]["uuid"], "expires": prof["attributes"]["expirationDate"]},
          "files": {"p12": p12, "profile": profile_path, "privateKey": key_pem}})


def cmd_uba_credentials(out_dir: str, label: str) -> None:
    org = env("UNITY_ORG_ID")
    project = os.environ.get("UNITY_PROJECT_ID") or UBA_DEFAULT_PROJECT
    boundary = "----SoccerMaster" + uuid.uuid4().hex
    parts: list[bytes] = []

    def field(name: str, value: bytes, filename: str | None = None, ctype: str | None = None) -> None:
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
        if filename:
            head += f'; filename="{filename}"'
        head += "\r\n"
        if ctype:
            head += f"Content-Type: {ctype}\r\n"
        parts.append(head.encode() + b"\r\n" + value + b"\r\n")

    field("label", label.encode())
    field("certificatePass", open(os.path.join(out_dir, "p12.pass"), "rb").read())
    field("fileCertificate", open(os.path.join(out_dir, "cert.p12"), "rb").read(), "cert.p12", "application/x-pkcs12")
    field("fileProvisioningProfile", open(os.path.join(out_dir, "appstore.mobileprovision"), "rb").read(), "appstore.mobileprovision",
          "application/octet-stream")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{UBA_API}/orgs/{org}/projects/{project}/credentials/signing/ios", data=body, method="POST")
    req.add_header("Authorization", "Basic " + env("UNITY_BUILD_API_KEY"))
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            res = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"UBA HTTP {e.code}\n{e.read().decode(errors='replace')[:2000]}")
    cert = res.get("certificate") or {}
    prof = res.get("provisioningProfile") or {}
    dump({"credentialid": res.get("credentialid"), "label": res.get("label"),
          "certificate": {k: cert.get(k) for k in ("teamId", "certName", "expiration", "isDistribution")},
          "provisioningProfile": {k: prof.get(k) for k in ("teamId", "expiration", "isEnterpriseProfile", "bundleId")}})


def cmd_upload(ipa: str, bundle: str, version: str, build: str) -> None:
    app = app_record(bundle)
    if not app:
        sys.exit(f"no App Store Connect app record for {bundle}; create it in App Store Connect → My Apps → + New App")
    size = os.path.getsize(ipa)
    up = api("POST", "/v1/buildUploads", {"data": {"type": "buildUploads",
        "attributes": {"cfBundleShortVersionString": version, "cfBundleVersion": build, "platform": "IOS"},
        "relationships": {"app": {"data": {"type": "apps", "id": app["id"]}}}}})["data"]
    print("buildUpload", up["id"], up["attributes"]["state"]["state"], flush=True)

    f = api("POST", "/v1/buildUploadFiles", {"data": {"type": "buildUploadFiles",
        "attributes": {"fileName": os.path.basename(ipa), "fileSize": size, "uti": "com.apple.ipa", "assetType": "ASSET"},
        "relationships": {"buildUpload": {"data": {"type": "buildUploads", "id": up["id"]}}}}})["data"]
    ops = f["attributes"]["uploadOperations"]
    print(f"buildUploadFile {f['id']} parts={len(ops)} bytes={size}", flush=True)

    md5 = hashlib.md5()
    sha = hashlib.sha256()
    with open(ipa, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            md5.update(chunk)
            sha.update(chunk)
        for op in sorted(ops, key=lambda o: o["offset"]):
            fh.seek(op["offset"])
            data = fh.read(op["length"])
            req = urllib.request.Request(op["url"], data=data, method=op.get("method", "PUT"))
            for h in op.get("requestHeaders", []):
                req.add_header(h["name"], h["value"])
            with urllib.request.urlopen(req, timeout=600) as resp:
                if resp.status not in (200, 201, 204):
                    sys.exit(f"part upload HTTP {resp.status}")
            print(f"  part offset={op['offset']} length={op['length']} ok", flush=True)

    api("PATCH", f"/v1/buildUploadFiles/{f['id']}", {"data": {"type": "buildUploadFiles", "id": f["id"],
        "attributes": {"uploaded": True, "sourceFileChecksums": {"file": {"hash": md5.hexdigest(), "algorithm": "MD5"}}}}})
    print("committed; ipa sha256", sha.hexdigest(), flush=True)

    while True:
        state = api("GET", f"/v1/buildUploads/{up['id']}")["data"]["attributes"]["state"]
        print(time.strftime("%H:%M:%S"), "upload", state["state"], flush=True)
        for kind in ("errors", "warnings"):
            for d in state.get(kind) or []:
                print(f"  {kind}: {d.get('code')} {d.get('description')}")
        if state["state"] == "COMPLETE":
            break
        if state["state"] == "FAILED":
            sys.exit("Apple rejected the upload")
        time.sleep(30)
    cmd_build_status(bundle, build, wait=True)


def find_build(app_id: str, build: str) -> dict | None:
    res = api("GET", "/v1/builds?" + urllib.parse.urlencode({"filter[app]": app_id, "filter[version]": build, "sort": "-uploadedDate", "limit": 5}))
    return res["data"][0] if res["data"] else None


def cmd_build_status(bundle: str, build: str, wait: bool = False) -> None:
    app = app_record(bundle) or sys.exit("no app record")
    while True:
        b = find_build(app["id"], build)
        state = b and b["attributes"]["processingState"]
        print(time.strftime("%H:%M:%S"), "processing", state, b and b["id"], flush=True)
        if not wait or state in ("VALID", "FAILED", "INVALID"):
            break
        time.sleep(30)
    if b:
        dump({"id": b["id"], "version": b["attributes"]["version"], "processingState": state, "expired": b["attributes"]["expired"],
              "usesNonExemptEncryption": b["attributes"].get("usesNonExemptEncryption"), "uploadedDate": b["attributes"]["uploadedDate"]})


def cmd_encryption(bundle: str, build: str) -> None:
    app = app_record(bundle) or sys.exit("no app record")
    b = find_build(app["id"], build) or sys.exit("no build")
    res = api("PATCH", f"/v1/builds/{b['id']}", {"data": {"type": "builds", "id": b["id"], "attributes": {"usesNonExemptEncryption": False}}})
    dump({"id": b["id"], "usesNonExemptEncryption": res["data"]["attributes"].get("usesNonExemptEncryption")})


def cmd_groups(bundle: str) -> None:
    app = app_record(bundle) or sys.exit("no app record")
    res = api("GET", f"/v1/apps/{app['id']}/betaGroups")
    dump([{"id": g["id"], "name": g["attributes"]["name"], "internal": g["attributes"]["isInternalGroup"],
           "publicLink": g["attributes"].get("publicLinkEnabled")} for g in res["data"]])


def cmd_distribute(bundle: str, build: str, group_name: str) -> None:
    app = app_record(bundle) or sys.exit("no app record")
    b = find_build(app["id"], build) or sys.exit("no build")
    groups = api("GET", f"/v1/apps/{app['id']}/betaGroups")["data"]
    g = one([x for x in groups if x["attributes"]["name"] == group_name], f"beta group {group_name}")
    api("POST", f"/v1/betaGroups/{g['id']}/relationships/builds", {"data": [{"type": "builds", "id": b["id"]}]})
    dump({"build": b["id"], "group": g["id"], "internal": g["attributes"]["isInternalGroup"]})


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    cmd, a = argv[0], argv[1:]
    if cmd == "check":
        cmd_check(a[0] if a else "com.codyengilman.soccermaster")
    elif cmd == "register-bundle-id":
        cmd_register_bundle_id(a[0], a[1])
    elif cmd == "signing":
        cmd_signing(a[0], a[1], *a[2:])
    elif cmd == "uba-credentials":
        cmd_uba_credentials(a[0], a[1])
    elif cmd == "upload":
        cmd_upload(a[0], a[1], a[2], a[3])
    elif cmd == "build-status":
        cmd_build_status(a[0], a[1], wait="--wait" in a)
    elif cmd == "encryption":
        cmd_encryption(a[0], a[1])
    elif cmd == "groups":
        cmd_groups(a[0])
    elif cmd == "distribute":
        cmd_distribute(a[0], a[1], a[2])
    else:
        sys.exit(f"unknown command {cmd}\n{__doc__}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
