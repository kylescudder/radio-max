"""Shared host deployer: verify an attested image, then start it with rollback.

Canonical copy: https://github.com/kylescudder/deploy-core. Each app vendors this
file unchanged as deploy/deploy_core.py and supplies its settings and hooks in
deploy/host-deploy.py. Do not edit a vendored copy; change deploy-core and sync.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from contextlib import contextmanager
import base64
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import time
from typing import Callable, Optional
import uuid

DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
REGISTRY_TOKEN = re.compile(r'[-A-Za-z0-9._~+/]{20,4096}={0,2}\Z')
KEEP_BACKUPS = 14
KEEP_STATUS = 50

# Set by configure(); tests patch these directly.
CONFIG = None
APP = STATE = BACKUPS = REQUESTS = STATUS = None


class Error(RuntimeError):
    pass


@dataclass
class App:
    """One deployable Compose service. Hooks receive images and may call this module."""
    name: str                    # log prefix and LaunchAgent label, e.g. 'big-day-planner'
    title: str                   # human name for messages, e.g. 'Big Day Planner'
    image: str                   # e.g. 'ghcr.io/kylescudder/big-day-planner'
    repo: str                    # e.g. 'kylescudder/big-day-planner'
    image_var: str               # compose.yaml image variable, pinned in .env
    service: str                 # Compose service name
    app_dir: Path                # checkout root holding .env, state/ and the compose file
    workflow: str = 'release.yml'
    branch: str = 'main'
    compose_file: str = 'compose.yaml'
    # Extra in-container health check after `up --wait`, e.g. an HTTP probe.
    health: Optional[Callable[[str], None]] = None
    # Acceptance checks for a started image: the candidate, an already-running
    # duplicate and a restored previous image must all pass.
    accept: Optional[Callable[[str], None]] = None
    # Runs after provenance and before start, e.g. backup and migrations.
    # Receives the candidate and the inspected current container (or None).
    prepare: Optional[Callable[[str, Optional[dict]], None]] = None
    # Runs after a recorded success with the deployment record.
    after_success: Optional[Callable[[dict], None]] = None
    # Publish {'revision','image'} to state/public/deployment.json for the receiver.
    public_status: bool = False
    # Publish phased release status to deploy-spool/status for the receiver.
    release_status: bool = False
    # Bind the attestation to the source commit with --source-digest.
    bind_source_digest: bool = False
    # Keep pre-deploy backups in backups/ (created on start).
    backups: bool = False
    # Refuse to run unless LocalHostName matches DEPLOY_HOSTNAME from the LaunchAgent.
    require_host: bool = False


def configure(app):
    global CONFIG, APP, STATE, BACKUPS, REQUESTS, STATUS
    CONFIG = app
    APP = Path(os.environ.get('APP_DIR', app.app_dir))
    STATE = APP / 'state'
    BACKUPS = APP / 'backups'
    REQUESTS = APP / 'deploy-spool/requests'
    # Read-only to the receiver, which serves it to GitHub as sanitized release status.
    STATUS = APP / 'deploy-spool/status'


def log(message):
    print(f'[{CONFIG.name}-deploy] {datetime.now(timezone.utc).isoformat()} {message}', flush=True)


def run(args, *, output=None, input_data=None, env=None, timeout=300):
    try:
        result = subprocess.run(args, cwd=APP, input=input_data, env=env,
                                stdout=output if output is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Error(f'{args[0]} operation timed out.') from None
    if result.returncode:
        # Command stderr and resolved environment can contain production credentials.
        raise Error(f'{args[0]} {args[1]} operation failed (exit {result.returncode}).')
    return result.stdout or b''


def compose(*args, image=None, output=None):
    env = os.environ.copy()
    if image:
        env[CONFIG.image_var] = image
    return run(['docker', 'compose', '--project-directory', str(APP), '-f', str(APP / CONFIG.compose_file),
                '--env-file', str(APP / '.env'), *args], env=env, output=output, timeout=180)


def private_env(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Error(f'{path.name} must be a protected regular file (0600).')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise Error(f'{path.name} contains an invalid environment entry.')
        values[key] = value.strip().strip('"\'')
    return values


def protected_file(path, what):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Error(f'{what} must be a protected regular file (0600).')
    return path


def save_json(path, value):
    temp = path.with_name(path.name + '.next')
    with temp.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(0o600)
    temp.replace(path)


def parse_json(raw, what):
    try:
        return json.loads(raw)
    except ValueError:
        # Never echo the data: it may contain container logs or credentials.
        raise Error(f'{what} returned unexpected output.') from None


class Progress:
    """Sanitized release status for GitHub: fixed phases only, never command output."""

    def __init__(self, digest=None, revision=None, requested=None):
        self.digest, self.revision, self.requested = digest, revision, requested
        self.phase, self.rollback = 'accepted', None

    def publish(self, status, phase=None):
        if phase:
            self.phase = phase
        if CONFIG.release_status and self.digest and self.revision:
            write_status(self.digest, self.revision, status, self.phase, self.rollback, self.requested)


# The current deployment's progress; hooks may publish their own phases.
progress = Progress()


def status_path(digest, revision):
    return STATUS / f'{revision}-{digest.removeprefix("sha256:")}.json'


def write_status(digest, revision, status, phase, rollback=None, requested=None):
    value = {'digest':digest, 'revision':revision, 'status':status, 'phase':phase,
             'updated_at':datetime.now(timezone.utc).isoformat()}
    if rollback:
        value['rollback'] = rollback
    if requested:
        value['requested'] = requested
    try:
        STATUS.mkdir(mode=0o700, parents=True, exist_ok=True)
        save_json(status_path(digest, revision), value)
        stale = sorted(STATUS.glob('*.json'), key=lambda path:path.stat().st_mtime, reverse=True)[KEEP_STATUS:]
        for old in stale:
            old.unlink(missing_ok=True)
    except OSError:
        # Reporting must never interrupt a deployment; GitHub then times out instead.
        log('could not publish release status')


def take_request():
    # Consume this snapshot only. Arrivals during deployment start the next run.
    if REQUESTS.is_symlink() or REQUESTS.parent.is_symlink():
        raise Error('Queue directories must not be symlinks.')
    # A receiver crash can leave a partial file. Remove old partials so launchd
    # does not keep restarting on a nonempty directory with no ready requests.
    for partial in REQUESTS.glob('.*.json.tmp'):
        if not partial.is_symlink() and partial.is_file() and time.time() - partial.stat().st_mtime > 30:
            partial.unlink()
    paths = sorted(REQUESTS.glob('*.json'))
    if not paths:
        return None
    valid = []
    for path in paths:
        try:
            if path.is_symlink() or path.stat().st_size > 8192:
                raise ValueError()
            value = json.loads(path.read_text())
            if not DIGEST.fullmatch(value.get('digest', '')) or not REVISION.fullmatch(value.get('revision', '')):
                raise ValueError()
            if type(value.get('timestamp')) is not int:
                raise ValueError()
            token = value.get('registryToken')
            if token is not None and (not isinstance(token, str) or not REGISTRY_TOKEN.fullmatch(token)):
                raise ValueError()
            valid.append((value['timestamp'], path.name, value))
        except (ValueError, TypeError, OSError, AttributeError):
            log('discarded malformed queue entry')
    selected = max(valid, key=lambda entry:entry[:2])[2] if valid else None
    if selected:
        save_json(STATE / 'last-request.json', {k:v for k,v in selected.items() if k != 'registryToken'})
    if CONFIG.release_status:
        for _, _, other in valid:
            if selected and (other['digest'], other['revision']) != (selected['digest'], selected['revision']):
                write_status(other['digest'], other['revision'], 'superseded', 'queued', requested=other['timestamp'])
    for path in paths:
        if path.is_dir() and not path.is_symlink():
            path.rename(STATE / ('rejected-directory-' + uuid.uuid4().hex))
        else:
            path.unlink(missing_ok=True)
    return selected


def pin(image):
    path = APP / '.env'
    lines = [line for line in path.read_text().splitlines() if not line.startswith(CONFIG.image_var + '=')]
    temp = path.with_name('.env.next')
    temp.write_text('\n'.join(lines) + f'\n{CONFIG.image_var}={image}\n')
    temp.chmod(0o600)
    temp.replace(path)


def start(image):
    compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', CONFIG.service, image=image)
    if CONFIG.health:
        CONFIG.health(image)


def accept(image):
    if CONFIG.accept:
        CONFIG.accept(image)


def publish_status(image, revision):
    if CONFIG.public_status:
        directory = STATE / 'public'
        directory.mkdir(mode=0o700, exist_ok=True)
        save_json(directory / 'deployment.json', {'revision':revision, 'image':image})


def inspect_current(container):
    # Parse the whole document rather than a delimited --format string: health check
    # logs from a failed candidate contain arbitrary text, including '|' and newlines.
    # Keep only the fields the deployer uses so nothing else is carried around.
    info = parse_json(run(['docker', 'inspect', container]), 'docker inspect')[0]
    state = info.get('State') or {}
    health = state.get('Health') or {}
    return {'Config': {'Image': (info.get('Config') or {}).get('Image'),
                       'Labels': (info.get('Config') or {}).get('Labels') or {}},
            'State': {'Running': bool(state.get('Running')), 'Status': state.get('Status'),
                      'Health': {'Status': health.get('Status')}}}


def backup_database(database):
    # Use the established database service locally. No administrator credential is
    # mounted in the app or sent to GitHub/the receiver.
    platform = APP.parents[1]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = BACKUPS / f'pre-deploy-{stamp}.dump'
    partial = target.with_suffix('.dump.partial')
    with partial.open('wb') as stream:
        run(['docker', 'compose', '--project-directory', str(platform), '-f', str(platform / 'compose.yaml'),
             'exec', '-T', '--user', 'postgres', 'postgres', 'pg_dump', '-Fc', '-d', database], output=stream)
    if partial.stat().st_size == 0:
        raise Error('Pre-deploy database backup was empty.')
    partial.replace(target)
    for old in sorted(BACKUPS.glob('pre-deploy-*.dump'), reverse=True)[KEEP_BACKUPS:]:
        old.unlink()
    log('saved pre-deploy database backup')


@contextmanager
def registry_credentials(token):
    if token is None:
        yield None
        return
    if not isinstance(token, str) or not REGISTRY_TOKEN.fullmatch(token):
        raise Error('Invalid temporary registry credential.')
    # The release job supplies a read-only, job-lifetime token. Its protected
    # queue file is consumed immediately; registry config is removed even on error.
    with tempfile.TemporaryDirectory(prefix=f'{CONFIG.name}-registry-') as folder:
        config = Path(folder) / 'config.json'
        credential = base64.b64encode((CONFIG.repo.split('/')[0] + ':' + token).encode()).decode()
        config.write_text(json.dumps({'auths':{'ghcr.io':{'auth':credential}}}))
        config.chmod(0o600)
        env = os.environ.copy()
        # A temporary DOCKER_CONFIG must retain the active local daemon endpoint.
        if not env.get('DOCKER_HOST'):
            endpoint = run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).decode().strip()
            if not endpoint.startswith('unix://'):
                raise Error('Expected a local Docker socket.')
            env['DOCKER_HOST'] = endpoint
        env.pop('DOCKER_CONTEXT', None)
        env.update({'DOCKER_CONFIG':folder, 'GH_TOKEN':token})
        yield env


def deploy(digest, requested_revision=None, registry_token=None):
    app = CONFIG
    if not DIGEST.fullmatch(digest):
        raise Error('Use an exact sha256 digest.')
    private_env(APP / '.env')
    candidate = f'{app.image}@{digest}'
    # compose.yaml requires the image variable, which .env lacks before the first release.
    ids = compose('ps', '-a', '-q', app.service, image=candidate).decode().strip().splitlines()
    if len(ids) > 1:
        raise Error(f'Expected a single {app.title} container.')
    current = inspect_current(ids[0]) if ids else None
    # A stopped container, such as a failed first candidate, is neither the previous
    # release to roll back to nor an already-healthy deployment.
    running = current['Config']['Image'] if current and current['State'].get('Running') else None
    if running == candidate and current['State'].get('Health', {}).get('Status') == 'healthy':
        revision = (current['Config'].get('Labels') or {}).get('org.opencontainers.image.revision', '')
        if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
            raise Error('Running image revision does not match the request.')
        log('requested digest is already healthy')
        accept(candidate)
        pin(candidate)
        publish_status(candidate, revision)
        progress.publish('succeeded', 'complete')
        return
    progress.publish('running', 'verify')
    log(f'verifying {candidate}')
    attestation = ['gh', 'attestation', 'verify', f'oci://{candidate}', '--bundle-from-oci', '--repo', app.repo,
                   '--signer-workflow', f'{app.repo}/.github/workflows/{app.workflow}',
                   '--source-ref', f'refs/heads/{app.branch}', '--deny-self-hosted-runners']
    if app.bind_source_digest and requested_revision:
        attestation.extend(['--source-digest', requested_revision])
    with registry_credentials(registry_token) as registry_env:
        run(attestation, timeout=180, env=registry_env)
        run(['docker', 'pull', '--quiet', candidate], timeout=300, env=registry_env)
    labels = parse_json(run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', candidate]),
                        'docker image inspect') or {}
    revision = labels.get('org.opencontainers.image.revision', '')
    if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
        raise Error('Verified image revision does not match the request.')
    if app.bind_source_digest and requested_revision is None:
        # Bind operator-selected rollback digests to the source commit too.
        run([*attestation, '--source-digest', revision], timeout=180)
    log(f'provenance verified for {revision}')
    if app.prepare:
        app.prepare(candidate, current)
    progress.publish('running', 'start')
    try:
        start(candidate)
        accept(candidate)
    except Error:
        log('candidate failed health check')
        progress.phase = 'health'
        if running and running != candidate:
            try:
                start(running)
                accept(running)
                pin(running)
                progress.rollback = 'restored'
                log('previous image restored; any migrations are not reverted')
            except Error:
                progress.rollback = 'failed'
                raise Error('ROLLBACK FAILED; inspect the private deployment logs.') from None
        else:
            progress.rollback = 'stopped'
            # Kept for `docker logs`; the next deploy replaces it whatever its state.
            compose('stop', app.service, image=candidate)
        raise Error('Candidate was not healthy; deploy failed.') from None
    pin(candidate)
    stamp = datetime.now(timezone.utc).isoformat()
    with (STATE / 'history.log').open('a') as stream:
        stream.write(f'{stamp} {candidate} {revision}\n')
    record = {'deployed_at':stamp, 'image':candidate, 'revision':revision, 'previous_image':running,
              'previous_revision':(current['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
              if running else None}
    save_json(STATE / 'deployment.json', record)
    publish_status(candidate, revision)
    if app.after_success:
        app.after_success(record)
    progress.publish('succeeded', 'complete')
    log(f'healthy on {candidate}')


def local_hostname():
    return subprocess.check_output(['/usr/sbin/scutil', '--get', 'LocalHostName']).decode().strip()


def main(argv):
    global progress
    os.umask(0o077)
    if CONFIG.require_host and local_hostname() != os.environ.get('DEPLOY_HOSTNAME'):
        raise Error('This deployer targets the host it was installed on only.')
    folders = [STATE, REQUESTS] + ([BACKUPS] if CONFIG.backups else []) + ([STATUS] if CONFIG.release_status else [])
    for folder in folders:
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(argv) > 1:
            raise Error('Usage: host-deploy.sh [sha256:<digest>]')
        request = {'digest':argv[0]} if argv else take_request()
        if request is None:
            log('no queued requests')
            return
        progress = Progress(request['digest'], request.get('revision'), request.get('timestamp'))
        try:
            progress.publish('running')
            deploy(request['digest'], request.get('revision'), request.get('registryToken'))
        except Exception as error:
            message = str(error) if isinstance(error, Error) else f'Deploy failed: {type(error).__name__}.'
            save_json(STATE / 'last-failure.json', {'failed_at':datetime.now(timezone.utc).isoformat(),
                      'digest':request['digest'], 'error':message})
            progress.publish('failed')
            raise


def install(script, hostname):
    """Install the event-driven LaunchAgent for this checkout; no interval or polling."""
    if not hostname or local_hostname() != hostname:
        raise SystemExit('Pass this host\'s LocalHostName: host-deploy.py --install <LocalHostName>')
    os.umask(0o077)
    label = f'com.kylescudder.{CONFIG.name}-deploy'
    folders = [STATE, REQUESTS, APP / 'deploy-spool/tmp'] + ([BACKUPS] if CONFIG.backups else []) + \
        ([STATE / 'public'] if CONFIG.public_status else []) + ([STATUS] if CONFIG.release_status else [])
    for folder in folders:
        # The receiver mounts deploy-spool; create its directories before Docker would.
        folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    # Retire any earlier agent that runs a deployer from this checkout under another label.
    for plist in agents.glob('*.plist'):
        try:
            old = plistlib.loads(plist.read_bytes())
        except Exception:
            continue
        args = old.get('ProgramArguments') or []
        if old.get('Label') != label and any(str(a).startswith(str(APP / 'deploy') + '/') for a in args):
            subprocess.run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{old["Label"]}'], capture_output=True)
            plist.unlink()
            print('Retired', old['Label'])
    value = {'Label':label, 'ProgramArguments':['/usr/bin/python3', '-B', str(Path(script).resolve())],
             'WorkingDirectory':str(APP), 'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
              'HOME':str(Path.home()), 'DOCKER_CONFIG':str(Path.home() / '.docker'), 'APP_DIR':str(APP),
              'DEPLOY_HOSTNAME':hostname},
             'QueueDirectories':[str(REQUESTS)], 'ThrottleInterval':10,
             'ProcessType':'Background', 'StandardOutPath':str(STATE / 'deploy.log'),
             'StandardErrorPath':str(STATE / 'deploy.log')}
    target = agents / (label + '.plist')
    target.write_bytes(plistlib.dumps(value))
    target.chmod(0o600)
    (STATE / 'deploy.log').touch(mode=0o600)
    subprocess.run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], capture_output=True)
    subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(target)], check=True)
    print('Installed', label, 'with QueueDirectories; runs as', os.getuid())


def cli(app, script):
    configure(app)
    args = sys.argv[1:]
    if args[:1] == ['--install']:
        install(script, args[1] if len(args) > 1 else None)
        return
    try:
        main(args)
    except (Error, OSError, ValueError, KeyError) as error:
        log(str(error) if isinstance(error, Error) else f'Deploy failed: {type(error).__name__}.')
        sys.exit(1)
