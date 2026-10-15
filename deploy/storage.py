"""Project-scoped image retention and deployment disk checks (runs on the server)."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path('/opt/todesk')
HISTORY = ROOT / '.successful-images.json'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def retained_refs(history):
    return {ref for release in history[:3] for ref in release}


def removable_refs(images, repositories, protected_ids, history):
    keep = retained_refs(history)
    return [ref for ref, image_id in images
            if ref.rsplit(':', 1)[0] in repositories
            and re.fullmatch(r'[0-9a-f]{40}', ref.rsplit(':', 1)[-1])
            and ref not in keep and image_id not in protected_ids]


def inventory():
    ids = docker('ps', '-aq').split()
    containers = json.loads(docker('inspect', *ids)) if ids else []
    images = [line.split() for line in docker(
        'image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'
    ).splitlines()]
    return containers, images


def prune(repositories, history):
    containers, images = inventory()
    protected = {container['Image'] for container in containers}
    for ref in removable_refs(images, repositories, protected, history):
        # No --force: Docker must also refuse removal if a container starts using it.
        subprocess.run(['docker', 'image', 'rm', ref], check=True)


def disk_status():
    paths = {ROOT, Path(docker('info', '--format', '{{.DockerRootDir}}'))}
    free = []
    warning = False
    for path in sorted(paths):
        usage = shutil.disk_usage(path)
        percent = (usage.total - usage.free) * 100 / usage.total
        print(f'{path}: {percent:.1f}% used, {usage.free / 2**30:.2f} GiB available', flush=True)
        free.append(usage.free)
        if percent >= 80:
            warning = True
            print(f'::warning::Disk usage at {path} is {percent:.1f}% (threshold 80%)', flush=True)
    return min(free), warning


def main():
    action = sys.argv[1]
    if action == 'monitor':
        _, warning = disk_status()
        # A failed scheduled run participates in GitHub Actions failure notifications.
        return 1 if warning else 0
    run = os.environ['DEPLOY_RUN']
    if not re.fullmatch(r'[0-9]+-[0-9]+', run):
        raise ValueError('Invalid deployment run identifier')
    staging = ROOT / '.deploy' / run
    if action == 'cleanup':
        if staging.exists():
            shutil.rmtree(staging)
        return 0
    repositories = os.environ['DEPLOY_REPOSITORIES'].split(',')
    history = json.loads(HISTORY.read_text()) if HISTORY.exists() else []
    if action == 'prepare':
        # On adoption, retain the deployed images; unknown old tags are not successful releases.
        containers, _ = inventory()
        current = sorted({c['Config']['Image'] for c in containers
                          if c['Config']['Image'].rsplit(':', 1)[0] in repositories})
        if not history and current:
            history = [current]
        available, _ = disk_status()
        if available < 8 * 2**30:
            prune(repositories, history)
            available, _ = disk_status()
        if available < 8 * 2**30:
            raise RuntimeError('Deployment needs at least 8 GiB free on upload and Docker filesystems; expand disk or inspect other usage')
        staging.mkdir(parents=True, exist_ok=True)
        HISTORY.write_text(json.dumps(history) + '\n')
    elif action == 'success':
        tag = os.environ['IMAGE_TAG']
        if not re.fullmatch(r'[0-9a-f]{40}', tag):
            raise ValueError('Invalid image tag')
        release = sorted(f'{repo}:{tag}' for repo in repositories)
        history = [release] + [old for old in history if old != release]
        temporary = HISTORY.with_suffix('.tmp')
        temporary.write_text(json.dumps(history[:3]) + '\n')
        temporary.replace(HISTORY)
        prune(repositories, history)
        disk_status()
    else:
        raise ValueError(f'Unknown action: {action}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
