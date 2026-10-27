"""Explicit adapter contract for trusted offline lesson dictionaries."""
from .engine import Lesson, TutorEngine


def from_offline_modules(records):
    lessons = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("each offline record must be a dictionary")
        try:
            answers = record["accepted_answers"]
            if not isinstance(answers, (list, tuple)):
                raise ValueError("accepted_answers must be a list or tuple")
            lessons.append(Lesson(
                id=record["id"], prompt=record["prompt"], answers=tuple(answers),
                hint=record["hint"], explanation=record["explanation"],
                remediation=record["remediation"], approved=record.get("approved", False)))
        except KeyError as exc:
            raise ValueError(f"missing offline field: {exc.args[0]}") from None
    return TutorEngine(lessons)


def from_learnloop_questions(questions, instruction_by_id):
    """Adapt the existing index.html localStorage db.questions record shape.

    Instructional text must be separately reviewed; original explanations often
    contain the correct option and should not be used as pre-answer hints.
    Accepted answers are option TEXT, not guessable option letters or indices.
    """
    records = []
    for question in questions:
        try:
            options, index = question['options'], question['correct']
            if not isinstance(options, list) or not options or type(index) is not int or not 0 <= index < len(options):
                raise ValueError('Invalid LearnLoop options/correct index')
            instructions = instruction_by_id[question['id']]
            records.append(dict(id=question['id'], prompt=question['stem'],
                accepted_answers=[options[index]], hint=instructions['hint'],
                explanation=instructions['explanation'], remediation=instructions['remediation'],
                approved=question.get('status') == 'approved' and instructions.get('approved') is True))
        except (KeyError, TypeError):
            raise ValueError('Question and reviewed instruction fields are required') from None
    return from_offline_modules(records)
