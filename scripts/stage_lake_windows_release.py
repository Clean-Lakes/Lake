#!/usr/bin/env python3
"""Supplement an existing release via SSH, using chunks below Git's blob limit."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHUNK_SIZE = 45 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    version = args.version
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?', version):
        raise SystemExit('Invalid version')
    base = subprocess.check_output(['git','rev-parse',f'refs/tags/v{version}^{{}}'],cwd=ROOT,text=True).strip()
    name = f'Lake-{version}-windows-x86_64'
    directory = ROOT / 'dist/windows' / version / 'x86_64'
    filenames = [name+'.zip', name+'.zip.sha256', name+'-setup.exe', name+'-setup.exe.sha256']
    for suffix in ['.zip', '-setup.exe']:
        file = directory / (name+suffix)
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if (directory / (file.name+'.sha256')).read_text().split() != [digest, file.name]:
            raise SystemExit('Artifact checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='lake-windows-release-index-') as temporary:
        env = os.environ.copy()
        env['GIT_INDEX_FILE'] = str(pathlib.Path(temporary)/'index')

        def git(*arguments, data=None):
            return subprocess.check_output(['git',*arguments],cwd=ROOT,env=env,input=data).decode().strip()

        def add(path, data):
            blob = git('hash-object','-w','--stdin',data=data)
            git('update-index','--add','--cacheinfo',f'100644,{blob},{path}')

        git('read-tree',base)
        # Only the publishing workflow runs on this temporary asset ref.
        for path in git('ls-files','.github/workflows').splitlines():
            git('update-index','--force-remove',path)
        add('.github/workflows/publish-windows-assets.yml',(ROOT/'.github/workflows/publish-windows-assets.yml').read_bytes())
        metadata = {'version':version,'baseReleaseCommit':base,'assets':{}}
        for filename in filenames:
            file = directory/filename
            full_digest = hashlib.sha256(file.read_bytes()).hexdigest()
            parts = []
            with file.open('rb') as stream:
                index = 0
                while data := stream.read(CHUNK_SIZE):
                    part_name = f'chunk-{full_digest}-{index:03d}'
                    add('release-assets/windows/'+part_name,data)
                    parts.append({'name':part_name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
                    index += 1
            metadata['assets'][filename] = {'size':file.stat().st_size,'sha256':full_digest,'parts':parts}
        add('release-assets/windows/release.json',json.dumps(metadata,indent=2).encode())
        commit = git('commit-tree',git('write-tree'),'-p',base,data=f'Supplement Windows x86_64 assets for v{version}\n'.encode())
    tag = f'lake-windows-assets-v{version}-{int(time.time())}'
    subprocess.run(['git','tag',tag,commit],cwd=ROOT,check=True)
    record = {'tag':tag,'commit':commit,'version':version}
    pathlib.Path('/tmp/lake-windows-supplement-operation.json').write_text(json.dumps(record))
    print(json.dumps(record),flush=True)
    subprocess.run(['git','push','origin','refs/tags/'+tag],cwd=ROOT,check=True)
    print('Windows asset relay dispatched',flush=True)


if __name__=='__main__':
    main()
