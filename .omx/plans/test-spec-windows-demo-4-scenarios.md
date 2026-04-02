# Test Spec: Windows demo four-scenario parity

## Verification targets
1. Build/type/lint safety for touched TypeScript sources:
   - `pnpm build`
   - `pnpm typecheck`
   - `pnpm lint`
2. Flutter Windows app still analyzes/builds:
   - `flutter test` in `apps/demo-flutter`
   - `flutter build windows --debug` or equivalent Windows run/build evidence
3. End-to-end Windows demo validation:
   - Start signaling server on :8080
   - Start demo-web on :3000
   - Start Flutter Windows client
   - Confirm `/api/state` reaches `connectionState=connected`
   - Confirm scenario1 `completedFiles === totalFiles`
   - Confirm scenario2 `verified === true`
   - Confirm scenario3 `tick > 0`
   - Confirm scenario4 `framesSent > 0`
4. Large-file emphasis:
   - Use fresh runtime evidence showing scenario2 transferred a non-trivial payload and the hashes match.

## Evidence capture
- Preserve command outputs/logs for build/test and runtime validation.
- Prefer direct `/api/state` snapshots and process logs over assumptions.
