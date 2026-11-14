# Rebuild index.html from src/. Run: python3 build.py
s = open('src/shell.html').read()
for k, f in [('/*CSS*/', 'src/app.css'), ('/*CORE*/', 'src/core.js'), ('/*APP*/', 'src/site.js')]:
    s = s.replace(k, open(f).read())
# Build id: the published page compares it with the live index.html and reloads itself when it changes
import hashlib
s = s.replace('/*BUILD*/', hashlib.sha256(s.encode()).hexdigest()[:12])
open('index.html', 'w').write(s)
print('index.html', len(s), 'bytes')
