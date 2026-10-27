import json
from . import from_offline_modules


def main():
    engine = from_offline_modules([dict(
        id="addition", prompt="What is two plus two?", accepted_answers=["4", "four"],
        hint="Could you count two objects and then two more?",
        explanation="Addition combines groups. Count each item once.",
        remediation="Practice counting a small group of objects aloud.", approved=True)])
    print(json.dumps(engine.start("demo", "addition").to_dict()))
    for i, response in enumerate(["5", "6", "7", "4", "4"]):
        print(json.dumps(engine.submit("demo", response, str(i)).to_dict()))


if __name__ == "__main__":
    main()
