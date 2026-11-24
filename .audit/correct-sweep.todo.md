# correct-sweep todo — /poteto-mode /correct + /no-comments + /create-formal-verification-skill

Playbook: correct skill, plus operator-mandated steps. Each step ships as one verifiable PR.

## correct skill steps (verbatim)

1. First, read recent commits, reverts, review comments, agent instruction files, and comments that explain workarounds. Group the mistakes into classes. A class counts once it has happened twice.
2. Fix each class at the highest level that works: (1) eliminate with architecture, (2) enforce with types, then a lint or CI check whose error names the fix, (3) test the behavior, (4) docs or agent rules last, only for judgment calls.
3. Then fix the most frequent classes now, one commit each. Prove each new check fails on a real past mistake. Run the same command locally and in CI. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.
4. Last, keep a table in the agent instruction file that pairs each rule with what enforces it. When the operator corrects you, fix the mistake and add the rule. Drop a rule once its mistake can't happen.

## Operator-mandated steps

5. /no-comments: spawn comment-sicko on the repo, act on accepted findings; delete comments that restate code; encode the constraint behind comments that matter.
6. /create-formal-verification-skill: where concurrency, retries or state machines caused real bugs, write a formal model that replays a past bug and fails on it; run it in CI.
7. Replace unit tests that pin implementation with those models plus real DB and e2e tests; keep every test that guards security or legal behavior.
8. Ship one verifiable PR per step; prove each check catches a real past mistake before trusting it.

## Skip lines

(none yet)
