"""Create a local CA and a short-lived host certificate for optional LAN TLS."""
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import os
import socket
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

import psutil


def _tls_data_dir():
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return root / "SuperShare" / "tls"


def _private_key_bytes(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def _host_addresses():
    addresses = set()
    try:
        for entries in psutil.net_if_addrs().values():
            for entry in entries:
                if entry.family == socket.AF_INET and entry.address and not entry.address.startswith("127."):
                    addresses.add(entry.address)
    except Exception:
        pass
    if not addresses:
        try:
            addresses.update(result[4][0] for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM)
                            if not result[4][0].startswith("127."))
        except OSError:
            pass
    return sorted(addresses)


def _create_ca(key_path: Path, cert_path: Path):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    subject = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SuperShare Local"),
        x509.NameAttribute(NameOID.COMMON_NAME, "SuperShare Local Root CA"),
    ])
    certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                   .public_key(key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
                   .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                   .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                               data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                               encipher_only=None, decipher_only=None), critical=True)
                   .sign(key, hashes.SHA256()))
    key_path.write_bytes(_private_key_bytes(key))
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    return key, certificate


def create_tls_context():
    cert_dir = _tls_data_dir()
    cert_dir.mkdir(parents=True, exist_ok=True)
    ca_key_path = cert_dir / "root-ca-key.pem"
    ca_cert_path = cert_dir / "root-ca.pem"
    leaf_key_path = cert_dir / "host-key.pem"
    leaf_chain_path = cert_dir / "host-chain.pem"
    if ca_key_path.exists() and ca_cert_path.exists():
        try:
            ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
            ca_cert = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
            if ca_key.public_key().public_numbers() != ca_cert.public_key().public_numbers():
                ca_key, ca_cert = _create_ca(ca_key_path, ca_cert_path)
        except (ValueError, TypeError):
            ca_key, ca_cert = _create_ca(ca_key_path, ca_cert_path)
    else:
        ca_key, ca_cert = _create_ca(ca_key_path, ca_cert_path)

    leaf_key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    subject = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SuperShare"),
        x509.NameAttribute(NameOID.COMMON_NAME, socket.gethostname()[:64]),
    ])
    names = [x509.DNSName("localhost")]
    hostname = socket.gethostname()
    if hostname and hostname.isascii() and all(character.isalnum() or character in ".-" for character in hostname):
        names.append(x509.DNSName(hostname))
    for address in _host_addresses():
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(address)))
        except ValueError:
            continue
    leaf_cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca_cert.subject)
                 .public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
                 .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=30))
                 .add_extension(x509.SubjectAlternativeName(names), critical=False)
                 .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                 .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                 .sign(ca_key, hashes.SHA256()))
    leaf_key_path.write_bytes(_private_key_bytes(leaf_key))
    leaf_chain_path.write_bytes(leaf_cert.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM))
    try:
        os.chmod(leaf_key_path, 0o600)
    except OSError:
        pass

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(leaf_chain_path, leaf_key_path)
    fingerprint = hashlib.sha256(ca_cert.public_bytes(serialization.Encoding.DER)).hexdigest()
    return context, {"ca_fingerprint": fingerprint, "ca_cert_path": str(ca_cert_path)}
