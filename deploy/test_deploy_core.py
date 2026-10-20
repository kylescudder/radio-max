"""Security gates, queue handling and rollback for the shared deployer, without a host."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('deploy_core', Path(__file__).with_name('deploy_core.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
D = 'sha256:' + 'a' * 64
R = 'b' * 40
IMAGE = 'ghcr.io/example/demo'
CANDIDATE = IMAGE + '@' + D
TOKEN = 'x' * 40


def docker_inspect(image, state, labels=None):
    # Shaped like `docker inspect <container>`: a one-element array of the full document.
    return json.dumps([{'Id':'container','Config':{'Image':image,'Labels':labels,'Env':['UNUSED=1']},'State':state}]).encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name)
        self.accept, self.prepare, self.after = Mock(), Mock(), Mock()
        core.configure(self.config())
        for d in (core.STATE, core.BACKUPS, core.REQUESTS):d.mkdir(parents=True)
        env=self.app/'.env';env.write_text('DEMO_IMAGE=previous\n');env.chmod(0o600)
        self.calls=[]
        self.composed=[]
        core.progress=core.Progress()

    def config(self, **overrides):
        values=dict(name='demo', title='Demo', image=IMAGE, repo='example/demo', image_var='DEMO_IMAGE',
                    service='web', app_dir=self.app, accept=self.accept, prepare=self.prepare,
                    after_success=self.after, public_status=True, backups=True)
        values.update(overrides)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('APP_DIR', None)
            return core.App(**values)

    def reconfigure(self, **overrides):
        core.configure(self.config(**overrides))

    def queue(self, name, timestamp, digest=D, **extra):
        (core.REQUESTS/name).write_text(json.dumps({'digest':digest,'revision':R,'timestamp':timestamp,**extra}))

    def fake_run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2]==['docker','inspect']:
            return docker_inspect('previous',{'Running':True,'Health':{'Status':'healthy'}},{})
        if args[:3]==['docker','image','inspect']:
            return json.dumps({'org.opencontainers.image.revision':R}).encode()
        return b''

    def fake_compose(self,*args,**kwargs):
        self.composed.append((args, kwargs.get('image')))
        if args[0]=='ps':return b'container\n'
        return b''

    def patched(self, run=None, compose=None, start=None):
        patches=[patch.object(core,'run',run or self.fake_run),patch.object(core,'compose',compose or self.fake_compose)]
        if start is not False:
            patches.append(patch.object(core,'start',start or Mock()))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return core.start


class Queue(Base):
    def test_newest_valid_request_wins_and_malformed_is_consumed(self):
        self.queue('old.json',10)
        self.queue('new.json',20,'sha256:'+'c'*64)
        (core.REQUESTS/'broken.json').write_text('{')
        self.assertEqual(core.take_request()['timestamp'],20)
        self.assertEqual(list(core.REQUESTS.iterdir()),[])
        self.assertIsNone(core.take_request())

    def test_symlink_cannot_read_outside_queue(self):
        private=self.app/'private';private.write_text('keep')
        (core.REQUESTS/'link.json').symlink_to(private)
        self.assertIsNone(core.take_request())
        self.assertEqual(private.read_text(),'keep')

    def test_replaced_queue_directory_is_rejected_without_touching_target(self):
        core.REQUESTS.rmdir()
        target=self.app/'other';target.mkdir()
        (target/'private.json').write_text('keep')
        core.REQUESTS.symlink_to(target)
        with self.assertRaises(core.Error):core.take_request()
        self.assertEqual((target/'private.json').read_text(),'keep')

    def test_malformed_directory_is_quarantined_without_a_launch_loop(self):
        (core.REQUESTS/'bad.json').mkdir()
        self.assertIsNone(core.take_request())
        self.assertEqual(list(core.REQUESTS.iterdir()),[])
        self.assertEqual(len(list(core.STATE.glob('rejected-directory-*'))),1)

    def test_stale_partial_is_removed_and_fresh_partial_is_left_alone(self):
        stale=core.REQUESTS/'.old.json.tmp';stale.write_text('partial');os.utime(stale,(0,0))
        fresh=core.REQUESTS/'.new.json.tmp';fresh.write_text('partial')
        self.assertIsNone(core.take_request())
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_registry_token_is_validated_and_never_recorded(self):
        self.queue('bad.json',10,registryToken='short')
        self.queue('good.json',20,registryToken=TOKEN)
        self.assertEqual(core.take_request()['registryToken'],TOKEN)
        self.assertNotIn(TOKEN,(core.STATE/'last-request.json').read_text())

    def test_superseded_requests_are_reported_only_with_release_status(self):
        self.queue('old.json',10,'sha256:'+'c'*64)
        self.queue('new.json',20)
        core.take_request()
        self.assertFalse(core.STATUS.exists())
        self.reconfigure(release_status=True)
        self.queue('old.json',10,'sha256:'+'c'*64)
        self.queue('new.json',20)
        core.take_request()
        status=json.loads(core.status_path('sha256:'+'c'*64,R).read_text())
        self.assertEqual((status['status'],status['phase']),('superseded','queued'))


class Deploy(Base):
    def test_healthy_same_digest_requires_the_requested_revision(self):
        raw=docker_inspect(CANDIDATE,{'Running':True,'Health':{'Status':'healthy'}},{'org.opencontainers.image.revision':R})
        start=self.patched(run=lambda args,**kw:raw)
        with self.assertRaises(core.Error):core.deploy(D,'c'*40)
        core.deploy(D,R)
        start.assert_not_called()
        self.accept.assert_called_once_with(CANDIDATE)
        self.assertIn('DEMO_IMAGE='+CANDIDATE,(self.app/'.env').read_text())

    def test_healthy_same_digest_rechecks_acceptance_before_acknowledging(self):
        raw=docker_inspect(CANDIDATE,{'Running':True,'Health':{'Status':'healthy'}},{'org.opencontainers.image.revision':R})
        self.accept.side_effect=core.Error('database unavailable')
        self.patched(run=lambda args,**kw:raw)
        with self.assertRaises(core.Error):core.deploy(D,R)
        self.assertFalse((core.STATE/'public/deployment.json').exists())

    def test_failed_verification_never_prepares_or_starts(self):
        def run(args,**kwargs):
            if args[0]=='gh':raise core.Error('verification rejected')
            return self.fake_run(args,**kwargs)
        start=self.patched(run=run)
        with self.assertRaises(core.Error):core.deploy(D,R)
        start.assert_not_called()
        self.prepare.assert_not_called()

    def test_attestation_is_restricted_to_the_workflow_branch_and_hosted_runners(self):
        self.reconfigure(workflow='deploy.yml', branch='master')
        self.patched()
        core.deploy(D,R)
        gh=next(a for a,_ in self.calls if a[0]=='gh')
        for flag,value in [('--repo','example/demo'),('--signer-workflow','example/demo/.github/workflows/deploy.yml'),
                           ('--source-ref','refs/heads/master')]:
            self.assertEqual(gh[gh.index(flag)+1],value)
        self.assertIn('--deny-self-hosted-runners',gh)
        self.assertNotIn('--source-digest',gh)

    def test_source_digest_binding_covers_requested_and_manual_digests(self):
        self.reconfigure(bind_source_digest=True)
        self.patched()
        core.deploy(D,R)
        core.deploy(D)
        gh=[a for a,_ in self.calls if a[0]=='gh']
        self.assertEqual([a[a.index('--source-digest')+1] for a in gh if '--source-digest' in a],[R,R])
        self.assertEqual(len(gh),3)

    def test_revision_mismatch_never_prepares_or_starts(self):
        start=self.patched()
        with self.assertRaises(core.Error):core.deploy(D,'c'*40)
        start.assert_not_called()
        self.prepare.assert_not_called()

    def test_failed_prepare_keeps_the_previous_image_and_does_not_start(self):
        self.prepare.side_effect=core.Error('migration rejected')
        start=self.patched()
        with self.assertRaises(core.Error):core.deploy(D,R)
        start.assert_not_called()
        self.assertFalse((core.STATE/'history.log').exists())
        self.assertIn('DEMO_IMAGE=previous',(self.app/'.env').read_text())

    def test_failed_health_restores_and_accepts_previous_without_recording_success(self):
        start=self.patched(start=Mock(side_effect=[core.Error('unhealthy'),None]))
        with self.assertRaises(core.Error):core.deploy(D,R)
        self.assertEqual([c.args[0] for c in start.call_args_list],[CANDIDATE,'previous'])
        self.accept.assert_called_once_with('previous')
        self.assertFalse((core.STATE/'history.log').exists())
        self.assertIn('DEMO_IMAGE=previous',(self.app/'.env').read_text())

    def test_failed_acceptance_restores_previous_without_acknowledging_candidate(self):
        previous={'revision':'c'*40,'image':IMAGE+'@sha256:'+'d'*64}
        (core.STATE/'public').mkdir()
        core.save_json(core.STATE/'public/deployment.json',previous)
        self.accept.side_effect=[core.Error('API acceptance failed'),None]
        start=self.patched()
        with self.assertRaises(core.Error):core.deploy(D,R)
        self.assertEqual([c.args[0] for c in start.call_args_list],[CANDIDATE,'previous'])
        self.assertFalse((core.STATE/'deployment.json').exists())
        self.assertEqual(json.loads((core.STATE/'public/deployment.json').read_text()),previous)
        self.assertIn('DEMO_IMAGE=previous',(self.app/'.env').read_text())

    def test_failed_rollback_is_reported(self):
        self.patched(start=Mock(side_effect=core.Error('unhealthy')))
        with self.assertRaisesRegex(core.Error,'ROLLBACK FAILED'):core.deploy(D,R)
        self.assertIn('DEMO_IMAGE=previous',(self.app/'.env').read_text())

    def test_success_is_pinned_recorded_and_new_arrival_remains_queued(self):
        self.patched(start=Mock(side_effect=lambda image:self.queue('arriving.json',30)))
        core.deploy(D,R)
        self.assertIn('DEMO_IMAGE='+CANDIDATE,(self.app/'.env').read_text())
        self.assertTrue((core.STATE/'history.log').exists())
        self.assertTrue((core.REQUESTS/'arriving.json').exists())
        self.assertEqual(json.loads((core.STATE/'public/deployment.json').read_text()),{'revision':R,'image':CANDIDATE})
        record=json.loads((core.STATE/'deployment.json').read_text())
        self.assertEqual((record['image'],record['previous_image']),(CANDIDATE,'previous'))
        self.after.assert_called_once_with(record)
        self.prepare.assert_called_once()
        self.assertEqual(self.prepare.call_args.args[0],CANDIDATE)

    def test_public_status_is_optional(self):
        self.reconfigure(public_status=False)
        self.patched()
        core.deploy(D,R)
        self.assertFalse((core.STATE/'public').exists())

    def test_start_runs_the_health_hook_after_compose_waits(self):
        health=Mock()
        self.reconfigure(health=health)
        self.patched(start=False)
        core.start(CANDIDATE)
        self.assertEqual(self.composed[0][0][:2],('up','-d'))
        self.assertIn('web',self.composed[0][0])
        health.assert_called_once_with(CANDIDATE)

    def test_inspect_survives_pipes_and_newlines_in_a_failed_health_log(self):
        log=[{'ExitCode':1,'Output':'error: boom\n3 | for (const path of paths) {\n  ^\n'},{'ExitCode':1,'Output':'a|b|c\n|\n'}]
        raw=docker_inspect(CANDIDATE,{'Status':'exited','Running':False,'Health':{'Status':'unhealthy','Log':log}},
                           {'org.opencontainers.image.revision':R})
        with patch.object(core,'run',return_value=raw):current=core.inspect_current('container')
        self.assertEqual(current,{'Config':{'Image':CANDIDATE,'Labels':{'org.opencontainers.image.revision':R}},
                                  'State':{'Running':False,'Status':'exited','Health':{'Status':'unhealthy'}}})

    def test_inspect_without_health_or_labels(self):
        raw=json.dumps([{'State':{'Status':'running','Running':True},'Config':{'Image':'previous','Labels':None}}]).encode()
        with patch.object(core,'run',return_value=raw):current=core.inspect_current('container')
        self.assertEqual(current['Config'],{'Image':'previous','Labels':{}})
        self.assertIsNone(current['State']['Health']['Status'])

    def test_unparseable_inspect_output_is_reported_without_echoing_it(self):
        with patch.object(core,'run',return_value=b'3 | secret-looking text'):
            with self.assertRaises(core.Error) as caught:core.inspect_current('container')
        self.assertNotIn('secret',str(caught.exception))

    def stopped(self, image, health='unhealthy'):
        log=[{'ExitCode':1,'Output':'3 | for (const path of paths) {\n'}]
        raw=docker_inspect(image,{'Status':'exited','Running':False,'Health':{'Status':health,'Log':log}},
                           {'org.opencontainers.image.revision':R})
        return lambda args,**kwargs:raw if args[:2]==['docker','inspect'] else self.fake_run(args,**kwargs)

    def test_stopped_failed_candidate_is_replaced_and_never_restored(self):
        start=self.patched(run=self.stopped(IMAGE+'@sha256:'+'c'*64),start=Mock(side_effect=core.Error('unhealthy')))
        with self.assertRaises(core.Error):core.deploy(D,R)
        self.assertEqual([c.args[0] for c in start.call_args_list],[CANDIDATE])
        self.assertIn((('stop','web'),CANDIDATE),self.composed)
        start.side_effect=None
        core.deploy(D,R)
        self.assertIn('DEMO_IMAGE='+CANDIDATE,(self.app/'.env').read_text())
        self.assertIsNone(json.loads((core.STATE/'deployment.json').read_text())['previous_image'])

    def test_stopped_container_of_the_requested_digest_is_started_not_acknowledged(self):
        start=self.patched(run=self.stopped(CANDIDATE,'healthy'))
        core.deploy(D,R)
        start.assert_called_once_with(CANDIDATE)

    def test_first_deploy_with_an_empty_env_file(self):
        (self.app/'.env').write_text('')
        def compose(*args,**kwargs):
            # With an empty .env, compose interpolation fails unless an image is supplied.
            if not kwargs.get('image'):raise core.Error('docker compose operation failed (exit 1).')
            return b''
        start=self.patched(compose=compose)
        core.deploy(D,R)
        start.assert_called_once_with(CANDIDATE)
        self.assertEqual((self.app/'.env').read_text().strip(),'DEMO_IMAGE='+CANDIDATE)

    def test_more_than_one_container_is_rejected(self):
        self.patched(compose=lambda *a,**k:b'one\ntwo\n')
        with self.assertRaises(core.Error):core.deploy(D,R)

    def test_registry_token_is_used_for_verification_and_pull_only(self):
        self.patched(run=lambda args,**kw:(self.fake_run(args,**kw) if args[:3]!=['docker','context','inspect']
                                           else b'unix:///tmp/docker.sock\n'))
        core.deploy(D,R,TOKEN)
        envs={a[0] if a[0]=='gh' else ' '.join(a[:2]):kw.get('env') for a,kw in self.calls}
        self.assertEqual(envs['gh']['GH_TOKEN'],TOKEN)
        self.assertEqual(envs['docker pull']['DOCKER_HOST'],'unix:///tmp/docker.sock')
        self.assertFalse(Path(envs['docker pull']['DOCKER_CONFIG']).exists())
        self.assertIsNone(envs['docker image'])

    def test_release_status_reports_fixed_phases(self):
        self.reconfigure(release_status=True)
        self.queue('request.json',10)
        self.patched(start=Mock(side_effect=core.Error('unhealthy\nsecret')))
        with self.assertRaises(core.Error):core.main([])
        status=json.loads(core.status_path(D,R).read_text())
        self.assertEqual((status['status'],status['phase'],status['rollback'],status['requested']),
                         ('failed','health','failed',10))
        self.assertNotIn('secret',json.dumps(status))


class Main(Base):
    def test_failed_request_records_failure_without_command_details(self):
        self.queue('request.json',10)
        def run(args,**kwargs):
            if args[0]=='gh':raise core.Error('gh attestation operation failed (exit 1).')
            return self.fake_run(args,**kwargs)
        self.patched(run=run)
        with self.assertRaises(core.Error):core.main([])
        failure=json.loads((core.STATE/'last-failure.json').read_text())
        self.assertEqual((failure['digest'],failure['error']),(D,'gh attestation operation failed (exit 1).'))

    def test_usage(self):
        with self.assertRaisesRegex(core.Error,'Usage'):core.main([D,D])

    def test_host_guard(self):
        self.reconfigure(require_host=True)
        with patch.object(core,'local_hostname',return_value='box'),patch.dict(os.environ,{'DEPLOY_HOSTNAME':'other'}):
            with self.assertRaisesRegex(core.Error,'installed on'):core.main([])
        with patch.object(core,'local_hostname',return_value='box'),patch.dict(os.environ,{'DEPLOY_HOSTNAME':'box'}):
            core.main([])

    def test_install_writes_agent_and_retires_an_older_label_for_this_checkout(self):
        home=self.app/'home';agents=home/'Library/LaunchAgents';agents.mkdir(parents=True)
        legacy=agents/'old.plist'
        legacy.write_bytes(plistlib.dumps({'Label':'old.label','ProgramArguments':['/usr/bin/python3','-B',str(self.app/'deploy/old-deploy.py')]}))
        other=agents/'other.plist'
        other.write_bytes(plistlib.dumps({'Label':'other','ProgramArguments':['/usr/bin/python3',str(self.app)+'-other/deploy/x.py']}))
        launchctl=[]
        with patch.object(core,'local_hostname',return_value='box'),patch.object(Path,'home',return_value=home),\
             patch.object(core.subprocess,'run',side_effect=lambda args,**kw:launchctl.append(args)):
            with self.assertRaises(SystemExit):core.install(str(self.app/'deploy/host-deploy.py'),'wrong')
            core.install(str(self.app/'deploy/host-deploy.py'),'box')
        agent=plistlib.loads((agents/'com.kylescudder.demo-deploy.plist').read_bytes())
        self.assertEqual(agent['ProgramArguments'][-1],str((self.app/'deploy/host-deploy.py').resolve()))
        self.assertEqual(agent['EnvironmentVariables']['DEPLOY_HOSTNAME'],'box')
        self.assertEqual(agent['QueueDirectories'],[str(core.REQUESTS)])
        self.assertFalse(legacy.exists())
        self.assertTrue(other.exists())
        self.assertIn(['/bin/launchctl','bootout',f'gui/{os.getuid()}/old.label'],launchctl)

    def test_install_creates_only_the_folders_the_app_uses(self):
        home=self.app/'home'
        self.reconfigure(backups=False, public_status=False, release_status=True)
        core.BACKUPS.rmdir()
        with patch.object(core,'local_hostname',return_value='box'),patch.object(Path,'home',return_value=home),\
             patch.object(core.subprocess,'run'):
            core.install(str(self.app/'deploy/host-deploy.py'),'box')
        for folder in ('state','deploy-spool/requests','deploy-spool/tmp','deploy-spool/status'):
            self.assertTrue((self.app/folder).is_dir(),folder)
        self.assertFalse((self.app/'backups').exists())
        self.assertFalse((self.app/'state/public').exists())


if __name__=='__main__':unittest.main()
