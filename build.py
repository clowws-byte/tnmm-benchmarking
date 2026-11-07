# Rebuild index.html from src/. Run: python3 build.py
s = open('src/shell.html').read()
for k, f in [('/*CSS*/', 'src/app.css'), ('/*CORE*/', 'src/core.js'), ('/*APP*/', 'src/site.js')]:
    s = s.replace(k, open(f).read())
open('index.html', 'w').write(s)
print('index.html', len(s), 'bytes')
