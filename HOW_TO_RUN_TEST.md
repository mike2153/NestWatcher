Run normal test suite:
pnpm test
Run full live I/O suite:
pnpm run test:live-io
Run only AutoPAC live tests:
pnpm run test:live-io:autopac
Run only Grundner live tests:
pnpm run test:live-io:grundner
alias: pnpm run test:live-io:grun
Run only Nestpick live tests:
pnpm run test:live-io:nestpick
alias: pnpm run test:live-io:nestp
Run live fuzz smoke:
pnpm run test:live-io:fuzz
If you want the slow “watch in Explorer” pace:

PowerShell:
$env:WOODTRON_LIVE_IO_FUZZ_DELAY_S='10'
then run pnpm run test:live-io:fuzz
And if you want more fuzz scenarios:

$env:WOODTRON_LIVE_IO_FUZZ_SCENARIOS='50'
then run pnpm run test:live-io:fuzz