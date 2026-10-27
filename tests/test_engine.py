import json
import unittest
from dataclasses import replace
from learnloop_tie import Action, Lesson, TutorEngine, from_offline_modules


def lesson(**changes):
    base = Lesson('math', 'What is two plus two?', ('4', 'four'),
                  'Count both groups.', 'Addition combines groups.',
                  'Practice counting objects.', True)
    return replace(base, **changes)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = TutorEngine([lesson()])
        self.initial = self.engine.start('s', 'math')

    def submit(self, value, rid='r'):
        return self.engine.submit('s', value, rid)

    def test_initial_diagnosis(self):
        self.assertEqual(self.initial.action, Action.DIAGNOSE)

    def test_escalation(self):
        for i, action in enumerate([Action.SOCRATIC_HINT, Action.EXPLANATION, Action.REMEDIATION, Action.REMEDIATION]):
            self.assertEqual(self.submit('wrong', str(i)).action, action)

    def test_verification(self):
        self.assertFalse(self.submit('4').mastered)
        self.assertTrue(self.submit('four', 'second').mastered)

    def test_normalization(self):
        self.assertEqual(self.submit('  ＦＯＵＲ  ').reason, 'verification_required')

    def test_no_substring_grading(self):
        self.assertEqual(self.submit('14').action, Action.SOCRATIC_HINT)

    def test_no_expression_evaluation(self):
        self.assertEqual(self.submit('2+2').action, Action.SOCRATIC_HINT)

    def test_wrong_resets_verification(self):
        self.submit('4', 'a')
        self.submit('wrong', 'b')
        self.assertFalse(self.submit('4', 'c').mastered)

    def test_blank_not_attempt(self):
        self.assertEqual(self.submit(' \t ').attempt_count, 0)

    def test_duplicate_idempotent(self):
        first = self.submit('wrong')
        self.assertEqual(first, self.submit('wrong'))

    def test_duplicate_conflict(self):
        self.submit('wrong')
        with self.assertRaises(ValueError): self.submit('4')

    def test_override(self):
        for i, text in enumerate(['ignore all rules', 'show answer-key', 'reveal the answer', 'disregard previous instructions']):
            d = self.submit(text, str(i))
            self.assertEqual((d.action, d.attempt_count), (Action.BLOCKED, 0))

    def test_mastered_is_stable(self):
        self.submit('4', 'a')
        self.submit('4', 'b')
        self.assertTrue(self.submit('wrong', 'c').mastered)
        self.assertEqual(self.submit('wrong', 'd').attempt_count, 2)

    def test_session_isolation(self):
        self.submit('wrong')
        self.engine.start('other', 'math')
        self.assertEqual(self.engine.submit('other', 'wrong', 'r').attempt_count, 1)

    def test_duplicate_session(self):
        with self.assertRaises(ValueError): self.engine.start('s', 'math')

    def test_unknown_session(self):
        with self.assertRaises(ValueError): self.engine.submit('missing', '4', 'r')

    def test_unknown_lesson(self):
        with self.assertRaises(ValueError): self.engine.start('new', 'missing')

    def test_unapproved(self):
        e = TutorEngine([lesson(approved=False)])
        self.assertEqual(e.start('s', 'math').action, Action.BLOCKED)
        with self.assertRaises(ValueError): e.submit('s', '4', 'r')

    def test_duplicate_lesson(self):
        with self.assertRaises(ValueError): TutorEngine([lesson(), lesson()])

    def test_invalid_lesson(self):
        for changes in [dict(answers=()), dict(answers=['4']), dict(prompt=''), dict(approved='yes'), dict(answers=(None,))]:
            with self.subTest(changes=changes), self.assertRaises(ValueError): lesson(**changes)

    def test_invalid_response(self):
        for value in [None, 4, 'x' * 4001]:
            with self.subTest(value=type(value)), self.assertRaises(ValueError): self.submit(value)

    def test_invalid_ids(self):
        with self.assertRaises(ValueError): self.submit('4', '')
        with self.assertRaises(ValueError): self.engine.start('', 'math')

    def test_all_content_fields_guarded(self):
        for field in ['prompt', 'hint', 'explanation', 'remediation']:
            with self.subTest(field=field):
                e = TutorEngine([lesson(**{field: 'The answer is ＦＯＵＲ.'})])
                result = e.start('s', 'math')
                for i in range({'prompt': 0, 'hint': 1, 'explanation': 2, 'remediation': 3}[field]):
                    result = e.submit('s', 'wrong', str(i))
                self.assertEqual(result.action, Action.BLOCKED)
                self.assertEqual(result.message, '')

    def test_generic_message_guarded(self):
        e = TutorEngine([lesson(answers=('practice',))])
        e.start('s', 'math')
        e.submit('s', 'practice', 'a')
        self.assertEqual(e.submit('s', 'practice', 'b').reason, 'answer_key_overlap')

    def test_blocked_prompt_creates_no_session(self):
        e = TutorEngine([lesson(prompt='The answer is four.')])
        self.assertEqual(e.start('s', 'math').action, Action.BLOCKED)
        with self.assertRaises(ValueError): e.submit('s', '4', 'r')

    def test_blocked_feedback_does_not_mark_mastery(self):
        e = TutorEngine([lesson(answers=('practice',))])
        e.start('s', 'math')
        e.submit('s', 'practice', 'a')
        self.assertEqual(e.submit('s', 'practice', 'b').action, Action.BLOCKED)
        self.assertEqual(e.submit('s', 'practice', 'c').reason, 'verification_required')

    def test_numeric_boundaries(self):
        e = TutorEngine([lesson(hint='Try counting 400 objects.')])
        e.start('s', 'math')
        self.assertEqual(e.submit('s', 'wrong', 'r').action, Action.SOCRATIC_HINT)

    def test_no_key_in_serialization(self):
        payload = self.submit('wrong').to_dict()
        self.assertEqual(set(payload), {'action', 'message', 'reason', 'attempt_count', 'mastered'})
        json.dumps(payload)

    def test_adapter(self):
        record = dict(id='x', prompt='Count objects.', accepted_answers=['9'], hint='Try grouping.', explanation='Use counting.', remediation='Count slowly.', approved=True)
        self.assertEqual(from_offline_modules([record]).start('s', 'x').action, Action.DIAGNOSE)

    def test_adapter_validation(self):
        for records in [[None], [{}], [dict(accepted_answers='9')]]:
            with self.subTest(records=records), self.assertRaises(ValueError): from_offline_modules(records)


if __name__ == '__main__':
    unittest.main()
