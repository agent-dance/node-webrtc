# PRD: Windows demo four-scenario parity

## Goal
Make the current Windows demo path preserve the original four-scenario design and run all scenarios successfully between Node demo-web and Flutter Windows, especially large-file transfer.

## Users
- Maintainers validating the demo locally on Windows.
- Reviewers comparing Windows behavior against the original demo design.

## Requirements
1. The Windows demo path must still establish signaling + WebRTC connection to `flutter-b`.
2. Scenario 1 (multi-file transfer) must complete with all files verified.
3. Scenario 2 (large-file transfer) must complete with matching SHA-256 and meaningful progress/speed reporting.
4. Scenario 3 (snake) must exchange state/input successfully enough to advance ticks and remain usable.
5. Scenario 4 (video) must stream frames successfully enough to update frame/fps counters without breaking the session.
6. The overview/status pages must continue to reflect scenario state using the existing design.

## Non-goals
- Redesigning the demo UI.
- Adding new external dependencies.
- Broad protocol rewrites beyond what Windows demo stability needs.

## Risks
- Flutter Windows SCTP/DataChannel behavior differs from macOS and may require conservative pacing.
- Scenario 4 raw-frame throughput may need Windows-specific throttling/framing.
