import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from collections import namedtuple
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).parents[1] / 'storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def test_only_old_project_sha_tags_without_container_references_are_removed(self):
        refs = [f'project/backend:{i:040x}' for i in range(6)]
        images = [(ref, str(i)) for i, ref in enumerate(refs)]
        images += [('other/backend:' + 'a' * 40, 'other'), ('project/backend:latest', 'latest')]
        history = [[refs[0]], [refs[1]], [refs[2]], [refs[3]]]
        self.assertEqual(storage.removable_refs(images, ['project/backend'], {'4'}, history),
                         [refs[3], refs[5]])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in [('ROOT', self.root), ('HISTORY', self.root / 'history.json')]:
            patcher = patch.object(storage, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.dict(os.environ, DEPLOY_RUN='123-2', DEPLOY_REPOSITORIES='project/backend', IMAGE_TAG='a' * 40)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_action(self, action):
        with patch('sys.argv', ['storage.py', action]):
            return storage.main()

    def test_insufficient_space_cleans_then_refuses_upload(self):
        with patch.object(storage, 'inventory', return_value=([], [])), \
                patch.object(storage, 'disk_status', return_value=(1024, True)), \
                patch.object(storage, 'prune') as prune:
            with self.assertRaisesRegex(RuntimeError, '8 GiB'):
                self.run_action('prepare')
            prune.assert_called_once()
            self.assertFalse((self.root / '.deploy').exists())

    def test_first_adoption_protects_current_images_before_space_cleanup(self):
        current = 'project/backend:' + 'b' * 40
        with patch.object(storage, 'inventory', return_value=([{'Config': {'Image': current}}], [])), \
                patch.object(storage, 'disk_status', side_effect=[(0, True), (9 * 2**30, False)]), \
                patch.object(storage, 'prune') as prune:
            self.run_action('prepare')
            prune.assert_called_once_with(['project/backend'], [[current]])
            self.assertEqual(json.loads(storage.HISTORY.read_text()), [[current]])

    def test_success_keeps_three_distinct_releases(self):
        storage.HISTORY.write_text(json.dumps([[f'project/backend:{i:040x}'] for i in range(4)]))
        with patch.object(storage, 'prune'), patch.object(storage, 'disk_status'):
            self.run_action('success')
            self.run_action('success')
        history = json.loads(storage.HISTORY.read_text())
        self.assertEqual(len(history), 3)
        self.assertEqual(history[0], ['project/backend:' + 'a' * 40])
        self.assertEqual(history[2], ['project/backend:' + f'{1:040x}'])

    def test_cleanup_only_this_attempt_and_is_repeatable(self):
        for run in ['123-1', '123-2']:
            path = self.root / '.deploy' / run
            path.mkdir(parents=True)
            (path / 'archive.tar.gz').write_text('partial upload')
        self.run_action('cleanup')
        self.run_action('cleanup')
        self.assertTrue((self.root / '.deploy/123-1/archive.tar.gz').exists())
        self.assertFalse((self.root / '.deploy/123-2').exists())

    def test_cleanup_rejects_path_traversal(self):
        with patch.dict(os.environ, DEPLOY_RUN='../other'):
            with self.assertRaises(ValueError):
                self.run_action('cleanup')

    def test_monitor_fails_at_alert_threshold(self):
        with patch.object(storage, 'disk_status', return_value=(9 * 2**30, True)):
            self.assertEqual(self.run_action('monitor'), 1)

    def test_disk_check_includes_separate_docker_filesystem_and_80_percent(self):
        usage = namedtuple('usage', 'total used free')
        with patch.object(storage, 'docker', return_value='/docker-data'), \
                patch.object(storage.shutil, 'disk_usage', side_effect=lambda path:
                             usage(100, 80, 20) if path == Path('/docker-data')
                             else usage(100, 50, 50)):
            self.assertEqual(storage.disk_status(), (20, True))

    def test_prune_uses_unforced_exact_refs_and_protects_stopped_containers(self):
        old = 'project/backend:' + '1' * 40
        stopped = 'project/backend:' + '2' * 40
        with patch.object(storage, 'inventory', return_value=(
                [{'Image': 'stopped-id'}], [(old, 'old-id'), (stopped, 'stopped-id')])), \
                patch.object(storage.subprocess, 'run') as run:
            storage.prune(['project/backend'], [])
            run.assert_called_once_with(['docker', 'image', 'rm', old], check=True)


if __name__ == '__main__':
    unittest.main()
