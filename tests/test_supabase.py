import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from learnloop_tie import SupabaseTutor


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = SupabaseTutor('https://example.supabase.co', 'public-key', 'user-token')

    def test_invalid_origin(self):
        for url in ['http://example.com', 'https://example.com/path', 'https://user@example.com', 'https://example.com?key=x']:
            with self.subTest(url=url), self.assertRaises(ValueError): SupabaseTutor(url, 'key', 'token')

    @patch('learnloop_tie.supabase.urlopen')
    def test_routes_and_auth(self, open_url):
        open_url.side_effect = lambda *a, **k: io.BytesIO(b'{"ok":true}')
        self.client.lessons()
        self.client.start('lesson', 'session')
        self.client.submit('session', 'wrong', 'request')
        self.client.resume('session')
        self.client.history()
        calls = open_url.call_args_list
        self.assertEqual([c.args[0].full_url.rsplit('/', 1)[1] for c in calls],
            ['tie_lessons', 'tie_start', 'tie_submit', 'tie_get', 'tie_history'])
        req = calls[2].args[0]
        self.assertEqual(req.get_header('Authorization'), 'Bearer user-token')
        self.assertEqual(json.loads(req.data), {'p_session_id': 'session', 'p_response': 'wrong', 'p_request_id': 'request'})

    @patch('learnloop_tie.supabase.urlopen')
    def test_http_error_does_not_echo_keys(self, open_url):
        open_url.side_effect = HTTPError('https://example', 401, 'user-token', {}, None)
        with self.assertRaisesRegex(RuntimeError, r'^Tutor request failed \(HTTP 401\)$'):
            self.client.lessons()

    @patch('learnloop_tie.supabase.urlopen')
    def test_network_error(self, open_url):
        open_url.side_effect = URLError('private detail')
        with self.assertRaisesRegex(RuntimeError, '^Tutor network request failed$'):
            self.client.lessons()

class BankClientTests(unittest.TestCase):
    @patch('learnloop_tie.supabase.urlopen')
    def test_bank_routes(self, open_url):
        open_url.side_effect=lambda *a, **k: io.BytesIO(b'{}')
        client=SupabaseTutor('https://example.supabase.co','public-key','user-token')
        client.catalog(); client.quiz_questions('quiz'); client.publish_bank({'questions':[],'quizzes':[]})
        calls=open_url.call_args_list
        self.assertEqual([x.args[0].full_url.rsplit('/',1)[1] for x in calls], ['tie_catalog','tie_quiz_questions','tie_publish_bank'])
        self.assertEqual(json.loads(calls[1].args[0].data), {'p_quiz_id':'quiz'})
