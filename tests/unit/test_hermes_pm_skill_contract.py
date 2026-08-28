from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).parents[2]
FLEET_SKILL = ROOT / "all-skills" / "agent-fleet-operations"
CONTRACT_PATH = FLEET_SKILL / "references" / "pm-deployment-contract.json"

REQUIRED_CORE = [
    "33god-projects",
    "delonet-conventions",
    "delonet-dotenv",
    "hermes-pm-template-maintenance",
    "hindsight",
    "subagent-driven-development",
]


def contract() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(CONTRACT_PATH.read_text(encoding="utf-8")))


def test_command_and_skill_core_are_immutable_and_additive() -> None:
    spec = contract()

    assert spec["schema_version"] == 2
    assert spec["deploy_command"] == ["pj", "hermes-agent", "--yes"]
    assert spec["required_skill_core"] == REQUIRED_CORE
    assert spec["skill_policy"] == {
        "core_is_immutable": True,
        "configuration_may_add_optional_skills": True,
        "configuration_may_remove_core_skills": False,
    }

    for name in REQUIRED_CORE:
        projection = ROOT / "sets" / "global" / name
        assert projection.is_symlink()
        assert (projection / "SKILL.md").is_file()


def test_preflight_and_project_transaction_fail_closed() -> None:
    spec = contract()
    preflight = spec["preflight"]
    project = spec["project_manifest"]

    assert preflight["reject_legacy_profile_symlink_before_mutation"] is True
    assert preflight["malformed_project_json"] == {
        "action": "abort",
        "project_json_byte_unchanged": True,
        "other_state_unchanged": True,
    }
    assert preflight["state_seal"] == {
        "before_and_after_required": True,
        "dirty_tracked_content_hashes_required": True,
        "untracked_content_hashes_required": True,
        "nested_git_required": [
            "HEAD",
            "index",
            "status",
            "dirty_content_hashes",
            "untracked_content_hashes",
        ],
    }
    assert project["transaction_lock_covers"] == [
        "read",
        "validate",
        "board_check_or_create",
        "write",
    ]
    assert project["replacement"] == "atomic"
    assert project["plane_binding"] == {
        "required_state": "linked",
        "live_identifier_required": True,
        "live_board_id_required": True,
        "forbidden_persisted_keys": ["board_url"],
    }


def test_runtime_exclusion_requires_ignore_and_index_absence() -> None:
    checks = contract()["runtime_exclusion"]["required_checks"]

    assert checks == [
        {
            "argv": [
                "git",
                "check-ignore",
                "-q",
                "--",
                "agents/hermes/pm/runtime/",
            ],
            "expect": "exit_0",
        },
        {
            "argv": [
                "git",
                "ls-files",
                "--",
                "agents/hermes/pm/runtime/",
            ],
            "expect": "empty_stdout",
        },
    ]


def test_profile_config_transactions_serialize_real_writers_and_recovery() -> None:
    spec = contract()
    transactions = spec["profile_config_transactions"]

    assert transactions["writers"] == [
        "initial_seed",
        "channel_adoption",
        "channel_rotation",
        "voice_reconcile",
        "render",
        "absorb",
        "recovery",
        "fleet_backfill",
    ]
    assert transactions["profile_root_must_be_real"] is True
    assert all(transactions["profile_lock"].values())
    assert transactions["registry_lock_order"] == ["registry", "profile"]
    assert transactions["lock_before_snapshot"] == [
        "durable_secret_references",
        "channel_identity",
        "registry_claim",
        "role_metadata",
        "config_delta",
        "generated_config",
    ]
    assert transactions["optimistic_snapshot_requires_locked_compare"] is True
    assert transactions["required_regressions"] == [
        "real_caller_voice_then_channel",
        "real_caller_channel_then_voice",
        "tokenless_adoption_and_rotation_both_orders",
        "initial_seed_and_backfill_contention",
        "truthful_timeout",
        "process_crash_release",
    ]

    replacement = spec["validated_config_replacement"]
    assert replacement["canonical_mutation_lock"] == {
        "scope": "whole_window",
        "named_profile_config": "per_profile_lock",
        "distributable_parent_config": "canonical_config_lock",
        "recovery_snapshot_install_share_lock": True,
    }
    assert replacement["serializes"] == [
        "stale_recovery",
        "snapshot",
        "install",
        "validation",
        "commit_or_restore",
        "cleanup",
    ]
    assert replacement["same_directory_protected_recovery"] is True
    assert replacement["backup_like_recovery_names_forbidden"] is True
    assert replacement["restore_before_optional_post_restore_validation"] is True
    assert replacement["exact_restore"] == [
        "device_and_inode",
        "bytes",
        "mode",
        "mtime_ns",
    ]
    assert replacement["candidate_install"] == "atomic"
    assert replacement["recovery_and_candidate_fsync_required"] is True


def test_channels_secrets_services_registry_and_git_are_fail_closed() -> None:
    spec = contract()

    assert spec["channels"] == {
        "unverified_profile_delta": {
            "platforms.telegram.enabled": False,
            "platforms.slack.enabled": False,
        },
        "enable_only_after_verified_credential_ownership": True,
    }
    assert spec["secrets"]["allowed_value_transport"] == [
        "pipe",
        "anonymous_fd",
        "process_memory",
    ]
    assert spec["secrets"]["forbidden_value_transport"] == [
        "curl_argv",
        "unrelated_child_environment",
    ]
    assert all(spec["secrets"]["transient_validation"].values())
    assert spec["secrets"]["eradication_scan_surfaces"] == [
        "current_text_database_cache_state",
        "git_index_and_staged_blobs",
        "local_reachable_refs",
        "local_reflogs",
        "local_unreachable_objects",
        "fetched_remote_reachable_refs",
    ]
    assert spec["secrets"]["authorization_required"] == [
        "rotation",
        "retirement",
        "private_remote_force_rewrite",
    ]
    assert spec["secrets"]["zero_downtime_rotation_order"] == [
        "inventory_consumers_and_reload_behavior",
        "create_distinct_replacement_while_old_remains_valid",
        "store_replacement_in_approved_vault",
        "update_and_reload_consumers_one_by_one",
        "verify_each_consumer_on_replacement",
        "revoke_old_credential_after_all_consumers_are_healthy",
        "verify_old_authentication_fails",
    ]
    assert spec["secrets"]["revoke_first"] == {
        "normal_rotation": False,
        "explicit_emergency_authorization_required": True,
        "outage_risk_acknowledgement_required": True,
        "recovery_plan_required": True,
    }
    assert spec["secrets"]["private_remote_rewrite_requires"] == [
        "named_remote_and_ref_scope",
        "protected_rollback_refs",
        "clean_clone_scan",
        "consumer_health",
        "old_clone_invalidation",
    ]
    assert spec["service_stabilization"] == {
        "bounded_window_required": True,
        "single_is_active_sample_is_sufficient": False,
        "required_observations": [
            "Result",
            "ExecMainStatus",
            "NRestarts",
            "latest_heartbeat_service_result",
        ],
    }
    assert spec["registry_rerun"] == {
        "preserve_fields": ["provisioned_at"],
        "preserve_extension_metadata": True,
        "preserve_unknown_fields": True,
        "byte_identical_when_inputs_unchanged": True,
    }

    git_contract = spec["git_transactions"]
    assert git_contract["repository_hooks_required"] is True
    assert git_contract["global_hooks_required"] is True
    assert git_contract["hook_bypass_forbidden"] is True
    assert git_contract["tracked_backup_cleanup"] == {
        "required_globs": ["*.bak", "*.bak-*", "*.orig", "*~", "*-backup.*"],
        "untrack_with_git_rm_cached": True,
        "remote_tree_verification_required": True,
        "preserve_unrelated_dirty_runtime_state": True,
    }


def test_human_runbooks_route_to_the_normative_contract() -> None:
    deployment = (FLEET_SKILL / "references" / "pm-deployment.md").read_text(encoding="utf-8")
    fleet_entrypoint = (FLEET_SKILL / "SKILL.md").read_text(encoding="utf-8")
    project_creation = (
        ROOT / "all-skills" / "projects" / "references" / "project-creation.md"
    ).read_text(encoding="utf-8")

    assert "pm-deployment-contract.json" in deployment
    assert "references/pm-deployment.md" in fleet_entrypoint
    assert "references/config-mutation-safety.md" in fleet_entrypoint
    assert "references/secret-migration.md" in fleet_entrypoint
    for reference in ("config-mutation-safety.md", "secret-migration.md"):
        assert (FLEET_SKILL / "references" / reference).is_file()
    assert "agent-fleet-operations" in project_creation
    assert "references/pm-deployment.md" in project_creation

    for name in ("agent-fleet-operations", "33god-agent-fleet-operations"):
        projection = ROOT / "sets" / "global" / name
        assert projection.is_symlink()
        assert projection.resolve() == FLEET_SKILL.resolve()
