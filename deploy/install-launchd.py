#!/usr/bin/env python3
"""Install Herman's event-driven deploy LaunchAgent; no interval or polling."""
import os
from pathlib import Path
import plistlib
import subprocess

app = Path(__file__).resolve().parents[1]
if subprocess.check_output(['/usr/sbin/scutil', '--get', 'LocalHostName']).decode().strip() != 'herman':
    raise SystemExit('This installer targets Herman only.')
os.umask(0o077)
label = 'com.herman.radio-max-deploy'
for name in ('state', 'state/public', 'deploy-spool/requests', 'deploy-spool/tmp'):
    (app / name).mkdir(parents=True, mode=0o700, exist_ok=True)
value = {'Label':label, 'ProgramArguments':['/usr/bin/python3', '-B', str(app / 'deploy/herman-deploy.py')],
         'WorkingDirectory':str(app), 'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          'HOME':str(Path.home()), 'DOCKER_CONFIG':str(Path.home() / '.docker'), 'APP_DIR':str(app)},
         'QueueDirectories':[str(app / 'deploy-spool/requests')], 'ThrottleInterval':10,
         'ProcessType':'Background', 'StandardOutPath':str(app / 'state/deploy.log'),
         'StandardErrorPath':str(app / 'state/deploy.log')}
target = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(plistlib.dumps(value))
target.chmod(0o600)
(app / 'state/deploy.log').touch(mode=0o600)
subprocess.run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], capture_output=True)
subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(target)], check=True)
print('Installed', label, 'with QueueDirectories; runs as the Colima owner', os.getuid())
