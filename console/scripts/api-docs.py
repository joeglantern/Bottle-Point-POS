"""Writes server/docs/api/console.md from the endpoint notes in console/src/api.js.

The console's data layer is the one place every console endpoint is written
down with its exact fields, so the reference is generated from it.

    python console/scripts/api-docs.py
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
src = (root / 'console/src/api.js').read_text(encoding='utf-8')

head = src[: src.index('export class ApiError')]
shapes = [l[3:] if l.startswith('// ') else l[2:] for l in head.splitlines() if l.startswith('//')]

out = [
    '# Console API',
    '',
    'Generated from `console/src/api.js` by `console/scripts/api-docs.py`. Edit the notes there, then run the script.',
    '',
    'Base path `/api/console`, reachable only on the console address. JSON in and out. Every endpoint except `/session/login` needs a console session (cookie).',
    'Errors are `{ "error": { "code", "message", "details" } }`.',
    '',
    'Money is integer cents (`*Cents`), percentages are basis points (`*Bps`, 150 = 1.5%), dates are ISO strings. Reads are open to every console role; who may write is given per section.',
    '',
    '## Shared shapes',
    '',
    '```',
    *shapes,
    '```',
]

body = src[src.index('export const api = {'):]
for m in re.finditer(r'  // ---- (.+?) ----|  /\*\*([\s\S]*?)\*/\n  (\w+):', body):
    if m.group(1):
        title = m.group(1)
        out += ['', '## ' + title[0].upper() + title[1:], '']
        continue
    doc = ' '.join(l.strip().lstrip('*').strip() for l in m.group(2).strip().splitlines()).strip()
    doc = re.sub(r'\s+', ' ', doc)
    mm = re.match(r'((?:GET|POST|PATCH|PUT|DELETE) \S+)(.*)', doc)
    if mm:
        out += [f'### `{mm.group(1)}`', '', mm.group(2).strip(), '']
    else:
        out.append(f'- `{m.group(3)}`: {doc}')

(root / 'server/docs/api/console.md').write_text('\n'.join(out) + '\n', encoding='utf-8', newline='\n')
print('wrote server/docs/api/console.md')
