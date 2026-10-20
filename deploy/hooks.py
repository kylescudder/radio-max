#!/usr/bin/env python3
"""RadioMax application-owned hooks for the installed deployment service."""
from pathlib import Path

import deploy_core as core


def accept(image):
    core.compose('exec', '-T', 'web', 'bun', '/app/deploy/verify.ts', image=image)


def after_success(record):
    # Public release record read by the app's own status checks.
    core.save_json(core.APP / 'deployment.json', {'released_at':record['deployed_at'], 'image':record['image'],
                   'revision':record['revision'], 'previous_image':record['previous_image'],
                   'previous_revision':record['previous_revision'], 'hostname':'radio-max.kylescudder.co.uk'})
