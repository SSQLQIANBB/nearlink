import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'migrate-database.sh'


class DatabaseDeploymentTests(unittest.TestCase):
    def run_deploy(self, fail_backup=False, fail_migration=False, custom_backup=False, blocked_backup=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # 原部署目录可能由管理员拥有，部署账号应使用自己的持久备份目录。
            (root / 'backups').write_text('unavailable legacy backup path')
            home = root / 'home'
            home.mkdir()
            backup_root = root / 'custom-backups' if custom_backup else home / '.local/state/nearlink/backups'
            if blocked_backup:
                backup_root.parent.mkdir(parents=True, exist_ok=True)
                backup_root.write_text('unavailable configured backup path')
            docker = root / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log: log.write(' '.join(args) + '\\n')
if '-p' in args: print('todesk')
elif args[0] == 'ps': print('mysql-container')
elif args[0] == 'inspect': print('backend:previous')
elif args[0] == 'exec':
 print('-- backup test data')
 sys.exit(int(os.environ.get('FAIL_BACKUP', '0')))
elif 'db:migrate' in args: sys.exit(int(os.environ.get('FAIL_MIGRATION', '0')))
''')
            docker.chmod(0o755)
            env = {**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'CALL_LOG': str(root / 'calls'),
                   'FAIL_BACKUP': str(int(fail_backup)), 'FAIL_MIGRATION': str(int(fail_migration)), 'IMAGE_TAG': 'test', 'HOME': str(home)}
            env.pop('DATABASE_BACKUP_DIR', None)
            if custom_backup:
                env['DATABASE_BACKUP_DIR'] = str(backup_root)
            result = subprocess.run(['bash', str(SCRIPT)], cwd=root, env=env, capture_output=True, text=True)
            calls = (root / 'calls').read_text().splitlines()
            if blocked_backup:
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(line.endswith('stop backend') or 'db:migrate' in line for line in calls))
                return result, calls
            backups = list(backup_root.glob('*/database.sql'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(backups[0].parent.stat().st_mode & 0o777, 0o700)
            self.assertLess(next(i for i, line in enumerate(calls) if line.endswith('stop backend')),
                            next(i for i, line in enumerate(calls) if line.startswith('exec ')))
            return result, calls

    def test_backup_precedes_migration(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(calls[-1].endswith('backend pnpm db:migrate'))

    def test_failed_backup_never_runs_migration(self):
        result, calls = self.run_deploy(fail_backup=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('db:migrate' in line for line in calls))

    def test_custom_backup_directory(self):
        result, _ = self.run_deploy(custom_backup=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unavailable_backup_directory_never_stops_writers(self):
        self.run_deploy(custom_backup=True, blocked_backup=True)

    def test_failed_migration_does_not_restart_writers(self):
        result, calls = self.run_deploy(fail_migration=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up -d' in line or 'start backend' in line for line in calls))
