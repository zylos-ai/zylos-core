#!/usr/bin/env python3
"""Opt-in real-binary acceptance. Only isolated temporary config is written."""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
from mock_provider import start

HERE = Path(__file__).resolve().parent

class Server:
    def __init__(self, binary, home, cwd, log):
        self.log = log.open('w')
        env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(home),
               'CODEX_HOME': str(home), 'TMPDIR': str(home / 'tmp')}
        (home / 'tmp').mkdir(exist_ok=True)
        self.process = subprocess.Popen([binary, 'app-server', '--stdio'],
            cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.log, text=True)
        self.events = queue.Queue()
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()
        try:
            self.call('initialize', {'clientInfo': {'name': 'zylos_permission_acceptance', 'version': '1'},
                                    'capabilities': {'experimentalApi': True}})
            self.send({'method': 'initialized'})
        except BaseException:
            self.close()
            raise

    def read(self):
        for line in self.process.stdout:
            try:
                self.events.put(json.loads(line))
            except ValueError:
                pass

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.events.get(timeout=max(.01, deadline - time.monotonic()))
            if result.get('id') == request_id:
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result['result']
        raise TimeoutError(method)

    def persist(self, thread_id):
        self.call('turn/start', {'threadId': thread_id,
            'input': [{'type': 'text', 'text': 'fixture', 'text_elements': []}]})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            event = self.events.get(timeout=max(.01, deadline - time.monotonic()))
            if event.get('method') == 'turn/completed':
                assert event['params']['turn']['status'] == 'completed', event
                return
        raise TimeoutError('turn/completed')

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except (subprocess.TimeoutExpired, BrokenPipeError):
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        finally:
            self.log.close()


def render(project_dir, project, global_config, enabled=True):
    # Do not leak a production proxy override into the isolated rendered fixture.
    env = {k: v for k, v in os.environ.items() if k not in
           ('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY')}
    result = subprocess.run(['node', str(HERE / 'render.mjs')],
        input=json.dumps({'projectDir': str(project_dir), 'project': project,
                          'global': global_config, 'bypassPermissions': enabled}),
        text=True, capture_output=True, check=True, env=env)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex', required=True, help='Installed Codex binary (no installation performed)')
    parser.add_argument('--output', required=True, type=Path, help='New evidence directory')
    args = parser.parse_args()
    binary = str(Path(args.codex).expanduser().resolve())
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix='zylos-codex-acceptance-')).resolve()
    mock, provider_config = start()
    results = {'binary': binary, 'version': subprocess.check_output([binary, '--version'], text=True).strip(),
               'tempRoot': str(root), 'cases': [], 'passed': False}
    restricted = 'approval_policy = "on-request"\nsandbox_mode = "read-only"\n'
    seed = 'model = "fixture"\n'
    cases = [
        ('fresh', '', [('never', 'dangerFullAccess')] * 3),
        ('explicit-restricted', restricted, [('on-request', 'readOnly')] * 2),
        ('explicit-named', 'approval_policy = "on-request"\ndefault_permissions = ":read-only"\n', [('on-request', 'readOnly')] * 2),
        ('explicit-workspace-options', '[sandbox_workspace_write]\nnetwork_access = false\n', [('never', 'readOnly')] * 2),
        ('edit-approval', '', [('on-request', 'dangerFullAccess')] * 2),
        ('edit-sandbox', '', [('never', 'readOnly')] * 2),
        ('toggle-disabled', '', [('on-request', 'readOnly')] * 2),
        ('toggle-reenabled', '', [('never', 'dangerFullAccess')] * 2),
        ('repeat-sync', '', [('never', 'dangerFullAccess')] * 2),
        ('untrusted-control', '', [('on-request', 'readOnly')] * 2),
        ('cli-only-control', '', [('never', 'dangerFullAccess'), ('never', 'readOnly')]),
    ]
    try:
        for name, existing, expected in cases:
            home = root / name / 'home'; cwd = root / name / 'project'
            home.mkdir(parents=True); (cwd / '.codex').mkdir(parents=True); (cwd / '.git').mkdir()
            generated = render(cwd, seed + existing, restricted + provider_config)
            if name.startswith('edit-'):
                before, after = ('approval_policy = "never"', 'approval_policy = "on-request"') if name == 'edit-approval' else ('sandbox_mode = "danger-full-access"', 'sandbox_mode = "read-only"')
                assert before in generated['project']
                generated = render(cwd, generated['project'].replace(before, after), generated['global'])
            if name.startswith('toggle-'):
                generated = render(cwd, generated['project'], generated['global'], False)
                if name == 'toggle-reenabled':
                    generated = render(cwd, generated['project'], generated['global'], True)
            if name == 'repeat-sync':
                again = render(cwd, generated['project'], generated['global'])
                assert again == generated, 'Repeated render changed configuration'
                generated = render(cwd, again['project'], again['global'])
                assert again == generated, 'Second repeated render changed configuration'
            if name == 'untrusted-control':
                generated['global'] = generated['global'].replace('trust_level = "trusted"', 'trust_level = "untrusted"')
            if name == 'cli-only-control':
                generated = render(cwd, seed, restricted + provider_config, False)
            (home / 'config.toml').write_text(generated['global'])
            (cwd / '.codex' / 'config.toml').write_text(generated['project'])
            case = {'name': name, 'phases': []}
            results['cases'].append(case)
            evidence = args.output / name; evidence.mkdir()
            (evidence / 'project.toml').write_text(generated['project'])
            (evidence / 'global.toml').write_text(generated['global'])
            for phase, want in enumerate(expected):
                server = Server(binary, home, cwd, evidence / f'{phase}.stderr')
                try:
                    params = {'cwd': str(cwd)} if phase == 0 else {'threadId': thread_id}
                    if name == 'cli-only-control' and phase == 0:
                        # Protocol equivalent of a one-time dangerous CLI override.
                        params.update(approvalPolicy='never', sandbox='danger-full-access')
                    response = server.call('thread/start' if phase == 0 else 'thread/resume', params)
                    thread_id = response['thread']['id']
                    actual = {key: response.get(key) for key in ('approvalPolicy', 'sandbox', 'activePermissionProfile')}
                    case['phases'].append({'phase': phase, 'request': params, 'actual': actual, 'expected': want})
                    assert (actual['approvalPolicy'], actual['sandbox']['type']) == want, (name, phase, actual, want)
                    if phase == 0:
                        server.persist(thread_id)
                finally:
                    server.close()
            case['passed'] = True
            print(f'PASS {name}', flush=True)
        results['passed'] = True
    finally:
        (args.output / 'results.json').write_text(json.dumps(results, indent=2))
        mock.shutdown()
    print(f'Evidence: {args.output}; preserved isolated fixtures: {root}')

if __name__ == '__main__':
    main()
