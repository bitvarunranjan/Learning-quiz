"""Read-only HTTP checks against the configured project. No account creation."""
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

config = (Path(__file__).resolve().parent.parent / 'tie-config.js').read_text()
url = re.search(r"url: '([^']+)'", config)[1]
key = re.search(r"publishableKey: '([^']+)'", config)[1]

def request(path, body=None):
    req = Request(url + path, headers={'apikey': key, 'Content-Type': 'application/json'},
                  data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(req, timeout=15) as res:
            return res.status, json.load(res)
    except HTTPError as exc:
        return exc.code, {}

status, settings = request('/auth/v1/settings')
assert status == 200, f'Auth settings HTTP {status}'
assert settings.get('external', {}).get('email') is True, 'Email authentication is not enabled'
for route, body in [
    ('tie_lessons', {}), ('tie_history', {}),
    ('tie_start', {'p_lesson_id': 'addition-demo', 'p_session_id': 'a7777777-7777-4777-8777-777777777777'}),
    ('tie_get', {'p_session_id': 'a7777777-7777-4777-8777-777777777777'}),
    ('tie_submit', {'p_session_id': 'a7777777-7777-4777-8777-777777777777', 'p_response': '4', 'p_request_id': 'b7777777-7777-4777-8777-777777777777'})
]:
    status, _ = request('/rest/v1/rpc/' + route, body)
    assert status in (401, 403), f'{route}: expected denied, got HTTP {status}'
    print(f'PASS: anonymous {route} denied (HTTP {status})')
print('PASS: live Auth endpoint reachable, email auth enabled; no accounts or emails created.')
