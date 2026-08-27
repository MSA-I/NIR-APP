# Every dictionary value is a single-quoted TS literal, so an apostrophe inside it has to be
# escaped. Insertion scripts kept forgetting; this normalises both files idempotently.
import io
import re

PATTERN = re.compile(r"^(\s{4}\w+: ')(.*)(',)$")

for path in ('src/lib/i18n/dictionaries/en.ts', 'src/lib/i18n/dictionaries/he.ts'):
    lines = io.open(path, encoding='utf-8').read().replace('\r\n', '\n').split('\n')
    fixed = 0
    out = []
    for line in lines:
        m = PATTERN.match(line)
        if not m:
            out.append(line)
            continue
        body = m.group(2).replace("\\'", "'")   # normalise first, so re-running is a no-op
        if "'" in body:
            fixed += 1
        out.append(m.group(1) + body.replace("'", "\\'") + m.group(3))
    io.open(path, 'w', encoding='utf-8', newline='').write('\n'.join(out))
    print(path, 'escaped', fixed)
