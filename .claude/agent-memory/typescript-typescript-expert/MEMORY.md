# Memory Index

## Project

- [openplate-sync gate and toolbox](project_openplate_sync_gate_and_toolbox.md): the real gate commands, the prettier baseline that already fails, the anti-slop rules that bite
- [A Postgres cascade hides a missing store delete](project_openplate_sync_feedback_admin_m200_06.md): feedback images: guard the store call with a fake-backed unit test, not an integration one
- [The en/em dash ban is narrow, not repo-wide](project_openplate_sync_dash_ban_is_narrow.md): only mail-messages.test.ts checks it; ~840 pre-existing dashes elsewhere pass the gate
- [HOST is an opt-in bind address](project_openplate_sync_host_bind_m201.md): the default must stay null, and express takes the listen options object through an untyped overload
- [A schema change reddens every integration test](project_a_schema_change_reddens_every_integration_test.md): no migration means every signup 500s; verify against a scratch database
- [An AccountView field is pinned by four lists](project_an_account_view_field_is_pinned_by_four_lists.md): two toAccountView builders, three frozen key whitelists tsc cannot see
- [A proxy refusal's position is checked by a grep](project_a_proxy_refusal_position_is_checked_by_a_grep.md): the tracker check greps line ORDER in proxy.ts, so a comment can break it
- [A tracker grep check reads comments too](project_a_tracker_grep_check_reads_comments_too.md): prose mentions and `{@link}` braces fail checks the code satisfies
- [The invite bounds left the admin router](project_the_invite_bounds_left_the_admin_router.md): MAX_DAILY_AI_LIMIT and DEFAULT_INVITE_TTL_MS moved to admin/invite-store.ts for config.ts
- [The admin tree has a third principal](project_the_admin_tree_has_a_third_principal.md): BILLING_TOKEN, default deny at the mount, 17 routes, and two fakes over one row
- [The integration TRUNCATE list is hand-maintained](project_the_integration_truncate_list_is_hand_maintained.md): a new table with no foreign key leaks between tests

## Feedback

- [Never git checkout a file to undo a defect injection](feedback_never_git_checkout_a_file_to_undo_a_defect_injection.md): it reverts to HEAD and eats the session's work; copy to /tmp first
