# Live provider check — 1 November 2026

Temporary provider credentials were loaded from the ignored root `.env.local`. No key values are recorded in this report or committed sources.

## Actual results from this machine/account

| Check | Result |
| --- | --- |
| Model availability | Cerebras listed `qwen-3.8-27b` |
| Short streaming reply | First text 387 ms; complete 390 ms; 7 output tokens |
| Capped generation sample | First text 547 ms; complete 571 ms; 192 output tokens; about 336 output tokens/s including network and startup |
| Exa lite search | 697 ms; one requested result; API reported $0.004 for that request |
| Real workspace agent | `get_project` → `exa_search` → cited final answer, 2.904 s |
| Guarded edit | `read_file` → reviewed `write_file` approval → persisted test-file contents, 3.058 s |
| Vision request | Accepted a robot CAD PNG; generated a board description in 2.243 s, 27 output tokens and 513 image tokens |

The longer generation sample deliberately reached its 192-token cap. Its provider-reported completion time was 45.94 ms (approximately 4,180 tokens/s for that short burst). This is not a sustained benchmark or a promised speed. Network latency and tool work dominate the observed end-to-end experience; human approval time was not included in the automated smoke check. Cerebras states that performance varies by model and configuration: https://www.cerebras.ai/pricing.

The real tool tests used a disposable blank project, not the user's robot source. An initial proposed write omitted an exact requested trailing newline; the checker rejected the proposal and confirmed the original file remained unchanged. A follow-up turn retained the refusal, so the smoke project's conversation was cleared and a simpler exact-content proposal was tested successfully. These results establish the permission/write path, not perfect instruction-following by the model. Always inspect a proposed edit; Clear conversation is available in the agent menu for a fresh demo attempt.

Search citations came from actual returned sources. Image input was accepted, but the generated board description was generic; it did not prove precise board identification or electrical correctness. No physical robot was connected, flashed or actuated by these checks.
