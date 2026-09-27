#!/usr/bin/env python3
"""Provision a separate REST-auth coturn listener and remote signing identity.

Run as root on the deployment host. Does not alter/restart the video TURN
instance, publish the remote feature, or print private material. Re-runs retain
the same keys. Back up the deployment directory before rotating keys manually.
"""
import argparse
import base64
import grp
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time


def write_private(path, text, mode=0o600):
    previous = path.stat() if path.exists() else None
    temporary = path.with_suffix(path.suffix + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w') as output:
        output.write(text)
    os.chmod(temporary, mode)
    if previous:
        os.chown(temporary, previous.st_uid, previous.st_gid)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', default='/opt/todesk')
    parser.add_argument('--public-ip', required=True)
    parser.add_argument('--private-ip', required=True)
    parser.add_argument('--hostname', default='turn.sycsq.top')
    parser.add_argument('--port', type=int, default=3480)
    parser.add_argument('--relay-min', type=int, default=49261)
    parser.add_argument('--relay-max', type=int, default=49360)
    args = parser.parse_args()
    import ipaddress
    import re
    for address in (args.public_ip, args.private_ip):
        ipaddress.IPv4Address(address)
    if not re.fullmatch(r'[a-zA-Z0-9.-]+', args.hostname):
        parser.error('invalid hostname')
    if not 1024 <= args.port < args.relay_min <= args.relay_max <= 65535:
        parser.error('invalid port range')
    if os.geteuid() != 0:
        parser.error('root required')
    deployment = Path(args.deployment)
    environment = deployment / '.env.production'
    original = environment.read_text()
    backup = deployment / 'backups' / time.strftime('remote-config-%Y%m%d-%H%M%S')
    backup.mkdir(mode=0o700, parents=True)
    shutil.copyfile(environment, backup / '.env.production')
    os.chmod(backup / '.env.production', 0o600)
    directory = deployment / 'secrets'
    directory.mkdir(mode=0o700, exist_ok=True)
    secret_path = directory / 'remote-turn-secret'
    if not secret_path.exists():
        write_private(secret_path, secrets.token_hex(32))
    secret = secret_path.read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{64}', secret):
        raise RuntimeError('invalid stored TURN secret')
    private = directory / 'remote-signing-key.pem'
    public = directory / 'remote-signing-public.json'
    if not private.exists():
        if public.exists():
            raise RuntimeError('public key exists without private key; refusing rotation')
        # Set umask before openssl creates the private key.
        os.umask(0o077)
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(private)], check=True)
        now = int(time.time() * 1000)
        der = subprocess.check_output(['openssl', 'pkey', '-in', str(private), '-pubout', '-outform', 'DER'])
        metadata = dict(keyId=time.strftime('production-%Y%m%d') + '-' + secrets.token_hex(4),
                        publicKey=base64.urlsafe_b64encode(der[-32:]).decode().rstrip('='),
                        notBefore=now - 300_000, notAfter=now + 365 * 86400_000)
        write_private(public, json.dumps(metadata, indent=2) + '\n')
    metadata = json.loads(public.read_text())
    if metadata['notAfter'] <= int(time.time() * 1000) + 86400_000:
        raise RuntimeError('signing key needs planned rotation')
    config = Path('/etc/turnserver-remote.conf')
    if config.exists():
        shutil.copyfile(config, backup / config.name)
        os.chmod(backup / config.name, 0o600)
    write_private(config, f'''# Managed by deploy/configure-remote-control.py; video TURN is independent.
listening-port={args.port}
listening-ip={args.private_ip}
relay-ip={args.private_ip}
external-ip={args.public_ip}/{args.private_ip}
realm={args.hostname}
use-auth-secret
static-auth-secret={secret}
min-port={args.relay_min}
max-port={args.relay_max}
fingerprint
stale-nonce
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
relay-threads=2
user-quota=12
total-quota=128
pidfile=/run/coturn-remote/turnserver.pid
log-file=stdout
simple-log
''', 0o640)
    os.chown(config, 0, grp.getgrnam('turnserver').gr_gid)
    unit = Path('/etc/systemd/system/coturn-remote.service')
    write_private(unit, '''[Unit]
Description=ToDesk remote-control TURN (short-lived credentials)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=turnserver
Group=turnserver
RuntimeDirectory=coturn-remote
ExecStart=/usr/bin/turnserver -c /etc/turnserver-remote.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run/coturn-remote /var/lib/turn
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
''', 0o644)
    updates = {
        'REMOTE_TURN_AUTH_MODE': 'rest',
        'REMOTE_TURN_SHARED_SECRET': secret,
        'REMOTE_TURN_URLS': f'turn:{args.hostname}:{args.port}?transport=udp,turn:{args.hostname}:{args.port}?transport=tcp',
        'REMOTE_STUN_URL': f'stun:{args.hostname}:{args.port}',
        'REMOTE_ICE_TRANSPORT_POLICY': 'all',
        'REMOTE_CONTROL_SIGNING_KEY_ID': metadata['keyId'],
        'REMOTE_CONTROL_SIGNING_PRIVATE_KEY': private.read_text().strip(),
        'REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE': str(metadata['notBefore']),
        'REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER': str(metadata['notAfter']),
    }
    replaced = set(updates) | {'REMOTE_TURN_USERNAME', 'REMOTE_TURN_PASSWORD'}
    lines = [line for line in original.splitlines() if line.partition('=')[0].strip() not in replaced]
    lines += [name + '=' + json.dumps(value) for name, value in updates.items()]
    write_private(environment, '\n'.join(lines) + '\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'coturn-remote'], check=True)
    subprocess.run(['systemctl', 'restart', 'coturn-remote'], check=True)
    subprocess.run(['systemctl', 'is-active', 'coturn', 'coturn-remote'], check=True)
    print(json.dumps({'publicSigningKey': metadata, 'turnPort': args.port,
                      'relayRange': [args.relay_min, args.relay_max], 'backup': str(backup)}))


if __name__ == '__main__':
    main()
