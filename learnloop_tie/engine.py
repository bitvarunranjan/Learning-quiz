"""Deterministic offline instructional policy. No network or model calls."""
from dataclasses import dataclass, field, asdict
from enum import Enum
import re
import unicodedata


class Action(str, Enum):
    DIAGNOSE = "diagnose"
    SOCRATIC_HINT = "socratic_hint"
    EXPLANATION = "explanation"
    REMEDIATION = "remediation"
    VERIFICATION = "verification"
    BLOCKED = "blocked"


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 4000:
        raise ValueError(f"{name} must be a nonempty string of at most 4000 characters")


@dataclass(frozen=True, repr=False)
class Lesson:
    id: str
    prompt: str
    answers: tuple[str, ...]
    hint: str
    explanation: str
    remediation: str
    approved: bool = False

    def __post_init__(self):
        for name in ("id", "prompt", "hint", "explanation", "remediation"):
            _text(getattr(self, name), name)
        if not isinstance(self.answers, tuple) or not self.answers:
            raise ValueError("answers must be a nonempty tuple")
        for answer in self.answers:
            _text(answer, "answer")
        if type(self.approved) is not bool:
            raise ValueError("approved must be boolean")


@dataclass(frozen=True)
class Decision:
    action: Action
    message: str
    reason: str
    attempt_count: int
    mastered: bool = False

    def to_dict(self):
        return {**asdict(self), "action": self.action.value}


@dataclass
class _Session:
    lesson_id: str
    attempts: int = 0
    pending_correct: bool = False
    mastered: bool = False
    replies: dict = field(default_factory=dict)


class TutorEngine:
    """Owns trusted in-memory progress; use one instance per learner.

    Callers must serialize concurrent calls. Session and request IDs are opaque
    application IDs, not learner-provided progress counters.
    """

    def __init__(self, lessons):
        self._lessons = {}
        for lesson in lessons:
            if not isinstance(lesson, Lesson):
                raise ValueError("expected Lesson objects")
            if lesson.id in self._lessons:
                raise ValueError("duplicate lesson id")
            self._lessons[lesson.id] = lesson
        self._sessions = {}

    def start(self, session_id: str, lesson_id: str) -> Decision:
        _text(session_id, "session_id")
        if session_id in self._sessions:
            raise ValueError("session already exists")
        if lesson_id not in self._lessons:
            raise ValueError("unknown lesson")
        lesson = self._lessons[lesson_id]
        if not lesson.approved:
            return Decision(Action.BLOCKED, "This lesson needs educator review.", "unapproved_content", 0)
        decision = self._safe(lesson, Action.DIAGNOSE, lesson.prompt, "initial_diagnosis", 0)
        if decision.action != Action.BLOCKED:
            self._sessions[session_id] = _Session(lesson_id)
        return decision

    def submit(self, session_id: str, response: str, request_id: str) -> Decision:
        _text(request_id, "request_id")
        if not isinstance(response, str) or len(response) > 4000:
            raise ValueError("response must be a string of at most 4000 characters")
        if session_id not in self._sessions:
            raise ValueError("unknown session")
        session = self._sessions[session_id]
        lesson = self._lessons[session.lesson_id]
        if request_id in session.replies:
            old_response, decision = session.replies[request_id]
            if response != old_response:
                raise ValueError("request id reused with different response")
            return decision
        value = normalize(response)
        if session.mastered:
            action, message, reason = Action.VERIFICATION, "Practice complete.", "already_mastered"
        elif not value:
            action, message, reason = Action.DIAGNOSE, "Try a response, or describe where you are stuck.", "empty_response"
        elif self._is_override(value):
            action, message, reason = Action.BLOCKED, "Please respond to the learning task.", "instruction_override"
        else:
            session.attempts += 1
            correct = value in {normalize(a) for a in lesson.answers}
            if correct:
                session.mastered = session.pending_correct
                session.pending_correct = True
                action = Action.VERIFICATION
                message = "Practice complete." if session.mastered else "Check your reasoning, then submit your response once more."
                reason = "confirmed_response" if session.mastered else "verification_required"
            else:
                session.pending_correct = False
                if session.attempts == 1:
                    action, message, reason = Action.SOCRATIC_HINT, lesson.hint, "first_error"
                elif session.attempts == 2:
                    action, message, reason = Action.EXPLANATION, lesson.explanation, "repeated_error"
                else:
                    action, message, reason = Action.REMEDIATION, lesson.remediation, "prerequisite_practice"
        decision = self._safe(lesson, action, message, reason, session.attempts, session.mastered)
        if decision.reason == "answer_key_overlap":
            session.pending_correct = False
            session.mastered = False
        session.replies[request_id] = (response, decision)
        return decision

    @staticmethod
    def _is_override(value):
        # Narrow deterministic override detector, not a general safety classifier.
        return bool(re.search(r"\b(ignore|disregard|override)\b.*\b(instructions|rules|policy)\b|\b(answer[ -]?key|system prompt|reveal the answer)\b", value))

    @staticmethod
    def _safe(lesson, action, message, reason, attempts, mastered=False):
        # Apply to EVERY output, including generic feedback and the initial prompt.
        # Whole-token matching avoids '4' matching '400'; NFKC handles fullwidth text.
        for answer in lesson.answers:
            pattern = r"(?<!\w)" + re.escape(normalize(answer)) + r"(?!\w)"
            if re.search(pattern, normalize(message)):
                return Decision(Action.BLOCKED, "", "answer_key_overlap", attempts, False)
        return Decision(action, message, reason, attempts, mastered)
