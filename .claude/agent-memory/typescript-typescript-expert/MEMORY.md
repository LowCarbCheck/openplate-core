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
- [A new CommonJS dependency must be external](project_a_new_commonjs_dependency_must_be_external.md): pnpm build greps the bundle for esbuild's dynamic-require shim
- [A required InstanceInfo field reddens five fixtures](project_a_required_instanceinfo_field_reddens_five_fixtures.md): five literals plus one deepEqual tsc cannot see
- [A collapse topic length is never 1 mod 4](project_a_collapse_topic_length_is_never_1_mod_4.md): Apple decodes the push topic as base64, FCM does not, so the bug is iPhone only

- [oxlint bites plain JS in openplate too](project_openplate_oxlint_bites_plain_js_too.md): public/*.js is linted, typeof is banned, and clearTimeout reads as a second resolve
- [An empty local store tombstones the whole diary](project_openplate_sync_tombstones_an_empty_store.md): stampSnapshot has no floor; the wipe spreads to healthy devices, and a backup restore undoes it
- [The openplate worker copies its pure logic](project_openplate_worker_copies_its_pure_logic.md): a classic service worker cannot import app code, so parity is a behavioural test with a mutation control

## Project (the sibling openplate app repo)

- [openplate app gate gotchas](project_openplate_app_gate_gotchas.md): an English-only i18n key reddens the gate, and the settings hub fixture is frozen
- [openplate app anti-slop lint](project_openplate_app_anti_slop_lint.md): Record<K,string> annotations and Record<string,unknown> are lint errors, in tests too
- [An openplate-notify grep counts peer comments](project_openplate_notify_grep_check_reads_peer_comments.md): push-decision.ts names the literal in prose and breaks the check

## Feedback

- [Never git checkout a file to undo a defect injection](feedback_never_git_checkout_a_file_to_undo_a_defect_injection.md): it reverts to HEAD and eats the session's work; copy to /tmp first
