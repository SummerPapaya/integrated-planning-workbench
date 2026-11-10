#!/usr/bin/env python3
"""Check local page, asset, and fragment targets within the deployable docs tree."""
from html.parser import HTMLParser
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1] / 'docs'

class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.links, self.ids, self.routes = [], set(), set()
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id'):
            self.ids.add(attrs['id'])
        if attrs.get('data-view'):
            self.routes.add(attrs['data-view'])
        for key in ('href', 'src'):
            if attrs.get(key):
                self.links.append(attrs[key])

def main():
    pages = {file: Page(file.read_text()) for file in ROOT.rglob('*.html')}
    errors = []
    checked = 0
    for file, page in pages.items():
        for raw in page.links:
            url = urlsplit(raw)
            if url.scheme or url.netloc or raw.startswith('//'):
                continue
            checked += 1
            target = (file.parent / unquote(url.path)).resolve() if url.path else file
            if target.is_dir():
                target /= 'index.html'
            if not target.is_relative_to(ROOT) or not target.is_file():
                errors.append(f'{file.relative_to(ROOT)}: missing local target {raw}')
            elif url.fragment and target in pages and unquote(url.fragment) not in pages[target].ids:
                # Main app tabs are routed by JavaScript, rather than element IDs.
                if target == ROOT / 'index.html' and url.fragment in ('forecast', 'psi', 'category', 'data', 'evidence', 'approval'):
                    continue
                if url.fragment in pages[target].routes and f'{url.fragment}-view' in pages[target].ids:
                    continue
                errors.append(f'{file.relative_to(ROOT)}: missing fragment {raw}')
    if errors:
        print('\n'.join(errors))
        return 1
    print(f'PASS: {len(pages)} HTML pages and {checked} local targets resolve within docs/.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
