"""Standard-library client for the authenticated LearnLoop Supabase tutor RPCs.

The database owns progress and answer keys. No service-role key is needed.
The application owns sign-in and token refresh, passing a current access token.
"""
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from uuid import uuid4


class SupabaseTutor:
    def __init__(self, url, publishable_key, access_token, *, timeout=15):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username:
            raise ValueError('Expected an HTTPS Supabase origin')
        if not all(isinstance(v, str) and v for v in (publishable_key, access_token)):
            raise ValueError('Publishable key and authenticated access token required')
        self._url = url.rstrip('/')
        self._key = publishable_key
        self._token = access_token
        self._timeout = timeout

    def _rpc(self, name, body):
        request = Request(self._url + '/rest/v1/rpc/' + name,
            data=json.dumps(body).encode(), headers={
                'apikey': self._key, 'Authorization': 'Bearer ' + self._token,
                'Content-Type': 'application/json'}, method='POST')
        try:
            with urlopen(request, timeout=self._timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            # Do not include server bodies or credential-bearing request reprs.
            raise RuntimeError(f'Tutor request failed (HTTP {exc.code})') from None
        except URLError:
            raise RuntimeError('Tutor network request failed') from None

    def lessons(self):
        return self._rpc('tie_lessons', {})

    def start(self, lesson_id, session_id=None):
        # Retain session_id and reuse it if retrying after a network error.
        return self._rpc('tie_start', {'p_lesson_id': lesson_id,
            'p_session_id': session_id or str(uuid4())})

    def submit(self, session_id, response, request_id):
        return self._rpc('tie_submit', {'p_session_id': session_id,
            'p_response': response, 'p_request_id': request_id})

    def resume(self, session_id):
        return self._rpc('tie_get', {'p_session_id': session_id})

    def history(self):
        return self._rpc('tie_history', {})
