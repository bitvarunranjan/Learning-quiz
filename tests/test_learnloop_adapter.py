import unittest
from learnloop_tie import from_learnloop_questions


class ExistingShapeTests(unittest.TestCase):
    def setUp(self):
        self.question = dict(id='m1', stem='What are the roots of x² − 5x + 6 = 0?',
            options=['1 and 6','2 and 3','−2 and −3','−1 and −6'], correct=1,
            explanation='The roots are 2 and 3.', status='approved')
        self.instructions = dict(hint='Which factors give the middle coefficient?',
            explanation='Compare the sum and product of the candidate roots.',
            remediation='Practice multiplying two binomials first.', approved=True)

    def test_existing_record_and_text_answer(self):
        engine = from_learnloop_questions([self.question], {'m1': self.instructions})
        engine.start('s','m1')
        self.assertEqual(engine.submit('s','B','r').action.value, 'socratic_hint')
        self.assertEqual(engine.submit('s','2 and 3','r2').reason, 'verification_required')

    def test_missing_review_defaults_to_blocked(self):
        self.instructions.pop('approved')
        e = from_learnloop_questions([self.question], {'m1': self.instructions})
        self.assertEqual(e.start('s','m1').action.value,'blocked')

    def test_pending_question_blocked(self):
        self.question['status']='pending'
        e = from_learnloop_questions([self.question], {'m1': self.instructions})
        self.assertEqual(e.start('s','m1').action.value,'blocked')

    def test_bad_indices(self):
        for index in [-1,4,True,'1']:
            self.question['correct']=index
            with self.subTest(index=index), self.assertRaises(ValueError):
                from_learnloop_questions([self.question], {'m1': self.instructions})

    def test_missing_instruction(self):
        with self.assertRaises(ValueError): from_learnloop_questions([self.question], {})
