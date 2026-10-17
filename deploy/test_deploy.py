"""Security gates, queue handling and rollback without production changes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployer', Path(__file__).with_name('herman-deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
D = 'sha256:' + 'a' * 64
R = 'b' * 40


class Deploy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Path(self.temp.name)
        self.patches = [patch.object(module, k, self.app / v) for k,v in
                        [('APP','.'),('STATE','state'),('REQUESTS','requests')]]
        for p in self.patches:p.start()
        for d in (module.STATE,module.REQUESTS):d.mkdir()
        for f in ('.env',):
            p=self.app/f;p.write_text('RADIO_MAX_IMAGE=previous\n');p.chmod(0o600)
        self.calls=[]

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        patch.stopall()
        self.temp.cleanup()

    def queue(self, name, timestamp, digest=D):
        (module.REQUESTS/name).write_text(json.dumps({'digest':digest,'revision':R,'timestamp':timestamp}))

    def test_newest_valid_request_wins_and_malformed_is_consumed(self):
        self.queue('old.json',10)
        self.queue('new.json',20,'sha256:'+'c'*64)
        (module.REQUESTS/'broken.json').write_text('{')
        self.assertEqual(module.take_request()['timestamp'],20)
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertIsNone(module.take_request())

    def test_symlink_cannot_read_outside_queue(self):
        private=self.app/'private';private.write_text('keep')
        (module.REQUESTS/'link.json').symlink_to(private)
        self.assertIsNone(module.take_request())
        self.assertEqual(private.read_text(),'keep')

    def test_replaced_queue_directory_is_rejected_without_touching_target(self):
        module.REQUESTS.rmdir()
        target=self.app/'other';target.mkdir()
        (target/'private.json').write_text('keep')
        module.REQUESTS.symlink_to(target)
        with self.assertRaises(module.Error):module.take_request()
        self.assertEqual((target/'private.json').read_text(),'keep')

    def test_malformed_directory_is_quarantined_without_a_launch_loop(self):
        (module.REQUESTS/'bad.json').mkdir()
        self.assertIsNone(module.take_request())
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertEqual(len(list(module.STATE.glob('rejected-directory-*'))),1)

    def test_stale_partial_is_removed_and_fresh_partial_is_left_alone(self):
        stale=module.REQUESTS/'.old.json.tmp';stale.write_text('partial');os.utime(stale,(0,0))
        fresh=module.REQUESTS/'.new.json.tmp';fresh.write_text('partial')
        self.assertIsNone(module.take_request())
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_healthy_same_digest_requires_the_requested_revision(self):
        current={'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                 'State':{'Running':True,'Health':{'Status':'healthy'}}}
        raw = '|'.join(json.dumps(v) for v in [current['Config']['Image'],current['State'],current['Config']['Labels']]).encode()
        with patch.object(module,'run',return_value=raw),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            module.deploy(D,R)
            start.assert_not_called()

    def fake_run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2]==['docker','inspect']:
            return '|'.join(json.dumps(v) for v in ['previous',{'Running':True,'Health':{'Status':'healthy'}},{}]).encode()
        if args[:3]==['docker','image','inspect']:
            return json.dumps({'org.opencontainers.image.revision':R}).encode()
        return b''

    def fake_compose(self,*args,**kwargs):
        if args[0]=='ps':return b'container\n'
        return b''

    def test_failed_provenance_never_pulls_or_starts(self):
        def run(args,**kwargs):
            if args[0]=='gh':raise module.Error('verification rejected')
            return self.fake_run(args,**kwargs)
        with patch.object(module,'run',run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            start.assert_not_called()

    def test_revision_mismatch_never_starts(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            start.assert_not_called()

    def test_failed_health_restores_previous_and_does_not_record_success(self):
        (module.STATE/'public').mkdir()
        acknowledgement=module.STATE/'public/deployment.json'
        acknowledgement.write_text('{"previous":"accepted"}')
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',side_effect=[module.Error('unhealthy'),None]) as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D,'previous'])
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('RADIO_MAX_IMAGE=previous',(self.app/'.env').read_text())
        self.assertEqual(acknowledgement.read_text(),'{"previous":"accepted"}')

    def test_attestation_requires_this_repository_workflow_and_master(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start'):
            module.deploy(D,R)
        attestation=next(call for call in self.calls if call[0]=='gh')
        self.assertIn('oci://'+module.IMAGE+'@'+D,attestation)
        self.assertEqual(attestation[attestation.index('--repo')+1],'kylescudder/radio-max')
        self.assertEqual(attestation[attestation.index('--signer-workflow')+1],
                         'kylescudder/radio-max/.github/workflows/release.yml')
        self.assertEqual(attestation[attestation.index('--source-ref')+1],'refs/heads/master')
        self.assertIn('--deny-self-hosted-runners',attestation)

    def test_completed_acceptance_contains_only_the_exact_image_and_revision(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start'):
            module.deploy(D,R)
        self.assertEqual(json.loads((module.STATE/'public/deployment.json').read_text()),
                         {'image':module.IMAGE+'@'+D,'revision':R})

    def test_initial_failed_release_stops_candidate_without_acknowledging_it(self):
        calls=[]
        def compose(*args,**kwargs):
            calls.append(args)
            return b''
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',compose),patch.object(module,'start',side_effect=module.Error('unhealthy')):
            with self.assertRaises(module.Error):module.deploy(D,R)
        self.assertIn(('stop','web'),calls)
        self.assertFalse((module.STATE/'public/deployment.json').exists())

    def test_rollback_failure_is_reported_without_an_acceptance_record(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',side_effect=module.Error('unhealthy')):
            with self.assertRaisesRegex(module.Error,'ROLLBACK FAILED'):module.deploy(D,R)
        self.assertFalse((module.STATE/'public/deployment.json').exists())

    def test_success_is_pinned_and_new_arrival_remains_queued(self):
        def start(image):self.queue('arriving.json',30)
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',start):module.deploy(D,R)
        self.assertIn(module.IMAGE+'@'+D,(self.app/'.env').read_text())
        self.assertTrue((module.STATE/'history.log').exists())
        self.assertTrue((module.REQUESTS/'arriving.json').exists())

    def test_registry_token_is_consumed_but_not_persisted_in_state(self):
        self.queue('request.json',10)
        path=module.REQUESTS/'request.json'
        data=json.loads(path.read_text())
        token='temporary_registry_fixture_value_only'
        data['registryToken']=token
        path.write_text(json.dumps(data))
        self.assertEqual(module.take_request()['registryToken'],token)
        self.assertNotIn(token,(module.STATE/'last-request.json').read_text())
        self.assertNotIn('registryToken',json.loads((module.STATE/'last-request.json').read_text()))
        self.assertEqual(list(module.REQUESTS.iterdir()),[])

    def test_invalid_registry_token_is_rejected_without_state(self):
        self.queue('request.json',10)
        path=module.REQUESTS/'request.json'
        data=json.loads(path.read_text());data['registryToken']='invalid\ncredential'
        path.write_text(json.dumps(data))
        self.assertIsNone(module.take_request())
        self.assertFalse((module.STATE/'last-request.json').exists())

    def test_registry_credentials_are_private_temporary_and_do_not_change_global_environment(self):
        import base64
        before=os.environ.get('GH_TOKEN')
        token='temporary_registry_fixture_value_only'
        with patch.object(module,'run',return_value=b'unix:///test-colima.sock'), module.registry_credentials(token) as env:
            config=Path(env['DOCKER_CONFIG'])/'config.json'
            self.assertEqual(config.stat().st_mode & 0o777,0o600)
            stored=json.loads(config.read_text())['auths']['ghcr.io']['auth']
            self.assertEqual(base64.b64decode(stored).decode(),'kylescudder:'+token)
            self.assertEqual(env['GH_TOKEN'],token)
            self.assertEqual(env['DOCKER_HOST'],os.environ.get('DOCKER_HOST') or 'unix:///test-colima.sock')
        self.assertFalse(config.exists())
        self.assertEqual(os.environ.get('GH_TOKEN'),before)

    def test_registry_credentials_are_removed_when_pull_fails(self):
        with self.assertRaises(module.Error):
            with patch.object(module,'run',return_value=b'unix:///test-colima.sock'), module.registry_credentials('temporary_registry_fixture_value_only') as env:
                config=Path(env['DOCKER_CONFIG'])/'config.json'
                raise module.Error('registry unavailable')
        self.assertFalse(config.exists())

    def test_healthy_container_is_not_acknowledged_when_api_checks_fail(self):
        current={'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                 'State':{'Running':True,'Health':{'Status':'healthy'}}}
        raw='|'.join(json.dumps(v) for v in [current['Config']['Image'],current['State'],current['Config']['Labels']]).encode()
        def compose(*args,**kwargs):
            if args[0]=='exec':raise module.Error('API acceptance failed')
            return self.fake_compose(*args,**kwargs)
        with patch.object(module,'run',return_value=raw),patch.object(module,'compose',compose):
            with self.assertRaises(module.Error):module.deploy(D,R)
        self.assertFalse((module.STATE/'public/deployment.json').exists())

    def test_registry_credentials_preserve_an_explicit_docker_endpoint(self):
        with patch.dict(os.environ,{'DOCKER_HOST':'unix:///existing-endpoint.sock'}):
            with module.registry_credentials('temporary_registry_fixture_value_only') as env:
                self.assertEqual(env['DOCKER_HOST'],'unix:///existing-endpoint.sock')

    def test_queue_accepts_opaque_job_tokens_without_recording_them(self):
        self.queue('request.json',10)
        path=module.REQUESTS/'request.json'
        token='opaque.fixture.'+'x'*600+'-suffix+/=='
        data=json.loads(path.read_text());data['registryToken']=token
        path.write_text(json.dumps(data))
        self.assertEqual(module.take_request()['registryToken'],token)
        self.assertNotIn(token,(module.STATE/'last-request.json').read_text())
        with patch.object(module,'run',return_value=b'unix:///test-colima.sock'), module.registry_credentials(token) as env:
            self.assertEqual(env['GH_TOKEN'],token)


if __name__=='__main__':unittest.main()
