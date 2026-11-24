#!/usr/bin/env python3
"""Build the Valenced plugin repository.

For every folder in plugins/ that has a manifest.json:
  - zips it to pool/<id>@<version>.zip (manifest, dist.script, dist.android.path, assets/)
  - then rebuilds index.json from every zip in pool/.

Usage:   python3 build.py [BASE_URL]
BASE_URL is where this Valenced folder is served, e.g. https://USER.github.io/REPO/Valenced
If omitted it comes from $BASE_URL, then from $GITHUB_REPOSITORY (GitHub Actions), then a placeholder.

A published version is never overwritten: if a plugin changed but its version did not, the build stops
and tells you to bump "version" in its manifest.json.
"""
import hashlib, json, os, re, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGINS, POOL = os.path.join(HERE, 'plugins'), os.path.join(HERE, 'pool')
FIXED_TIME = (2026, 1, 1, 0, 0, 0)  # fixed timestamp -> identical bytes -> stable sha256


def base_url():
    if len(sys.argv) > 1:
        return sys.argv[1].rstrip('/')
    if os.environ.get('BASE_URL'):
        return os.environ['BASE_URL'].rstrip('/')
    repo = os.environ.get('GITHUB_REPOSITORY')  # "owner/name"
    if repo:
        owner, name = repo.split('/', 1)
        return f'https://{owner.lower()}.github.io/{name}/Valenced'
    return 'https://YOURNAME.github.io/REPO/Valenced'


def version_key(v):
    m = re.match(r'^([0-9]+(?:\.[0-9]+)*)(?:-([0-9a-z]+))?$', v)
    if not m:
        raise SystemExit(f'Invalid version "{v}" (use 1.0.0 or 1.0.0-beta1)')
    nums = [int(x) for x in m.group(1).split('.')]
    nums += [0] * (10 - len(nums))
    return (nums, 0 if m.group(2) else 1)  # a labeled version sorts before its bare version


def files_for(folder, manifest):
    rels = ['manifest.json']
    dist = manifest.get('dist', {})
    if 'script' in dist:
        rels.append(dist['script'])
    if isinstance(dist.get('android'), dict) and dist['android'].get('path'):
        rels.append(dist['android']['path'])
    assets = os.path.join(folder, 'assets')
    if os.path.isdir(assets):
        for root, _, names in os.walk(assets):
            for n in names:
                rels.append(os.path.relpath(os.path.join(root, n), folder).replace(os.sep, '/'))
    for r in rels:
        if not os.path.isfile(os.path.join(folder, r)):
            raise SystemExit(f'{manifest.get("id")}: file listed in manifest is missing: {r}')
    return sorted(set(rels))


def zip_contents(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


def build_zip(folder, manifest):
    out = os.path.join(POOL, f'{manifest["id"]}@{manifest["version"]}.zip')
    tmp = out + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in files_for(folder, manifest):
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(folder, rel), 'rb') as f:
                z.writestr(info, f.read())
    if os.path.exists(out):
        # Compare what is inside the zips, not the raw bytes: the compressed bytes depend on the
        # zlib build of whatever machine runs this, so a byte comparison fails on unchanged plugins.
        if zip_contents(out) != zip_contents(tmp):
            os.remove(tmp)
            raise SystemExit(f'{manifest["id"]} {manifest["version"]} is already published but its files changed. '
                             f'Bump "version" in plugins/{os.path.basename(folder)}/manifest.json.')
        os.remove(tmp)
        return out, False
    os.replace(tmp, out)
    return out, True


def main():
    os.makedirs(POOL, exist_ok=True)
    for name in sorted(os.listdir(PLUGINS)) if os.path.isdir(PLUGINS) else []:
        folder = os.path.join(PLUGINS, name)
        mpath = os.path.join(folder, 'manifest.json')
        if not os.path.isfile(mpath):
            continue
        manifest = json.load(open(mpath, encoding='utf-8'))
        for k in ('format', 'id', 'name', 'version'):
            if k not in manifest:
                raise SystemExit(f'{name}/manifest.json is missing "{k}"')
        version_key(manifest['version'])
        path, new = build_zip(folder, manifest)
        print(('built   ' if new else 'unchanged ') + os.path.basename(path))

    base = base_url()
    cfg = json.load(open(os.path.join(HERE, 'repo.config.json'), encoding='utf-8'))
    plugins = {}
    for f in sorted(os.listdir(POOL)):
        if not f.endswith('.zip'):
            continue
        data = open(os.path.join(POOL, f), 'rb').read()
        mf = json.loads(zipfile.ZipFile(os.path.join(POOL, f)).read('manifest.json'))
        if f != f"{mf['id']}@{mf['version']}.zip":
            raise SystemExit(f'File name does not match its manifest: {f}')
        e = plugins.setdefault(mf['id'], {})
        # newest manifest wins for the listing fields
        if not e or version_key(mf['version']) >= version_key(max(e['versions'], key=version_key)):
            for k in ('name', 'description', 'author', 'contributors', 'icon'):
                if k in mf:
                    e[k] = mf[k]
        e.setdefault('versions', {})[mf['version']] = {
            'url': f'{base}/pool/{f}', 'sha256': hashlib.sha256(data).hexdigest(),
            'size': len(data), 'dependencies': mf.get('dependencies', {})}
    for e in plugins.values():
        vs = sorted(e['versions'], key=version_key)
        stable = [v for v in vs if '-' not in v]
        ch = {'latest': (stable or vs)[-1]}
        if vs[-1] != ch['latest']:
            ch['beta'] = vs[-1]
        e['channels'] = ch
    index = {'format': 1, 'name': cfg.get('name', 'Plugins'), 'description': cfg.get('description', ''), 'plugins': plugins}
    with open(os.path.join(HERE, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'index.json: {len(plugins)} plugin(s), base = {base}')


if __name__ == '__main__':
    main()
