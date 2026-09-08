# Memory Index

## Project

- [openplate-sync gate and toolbox](project_openplate_sync_gate_and_toolbox.md): the real gate commands, the prettier baseline that already fails, the anti-slop rules that bite
- [A Postgres cascade hides a missing store delete](project_openplate_sync_feedback_admin_m200_06.md): feedback images: guard the store call with a fake-backed unit test, not an integration one
- [The en/em dash ban is narrow, not repo-wide](project_openplate_sync_dash_ban_is_narrow.md): only mail-messages.test.ts checks it; ~840 pre-existing dashes elsewhere pass the gate
- [HOST is an opt-in bind address](project_openplate_sync_host_bind_m201.md): the default must stay null, and express takes the listen options object through an untyped overload
