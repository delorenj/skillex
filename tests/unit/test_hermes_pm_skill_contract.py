from __future__ import annotations

import json
from pathlib import Path

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


def contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_command_and_skill_core_are_immutable_and_additive() -> None:
    spec = contract()

    assert spec["deploy_command"] == ["pj", "hermes-agent", "--yes"]
    assert spec["required_skill_core"] == REQUIRED_CORE
    assert spec["skill_policy"] == {
        "core_is_immutable": True,
        "configuration_may_add_optional_skills": True,
        "configuration_may_remove_core_skills": False,
    }

    for name in REQUIRED_CORE:
        projection = ROOT / "skill-sets" / "global" / name
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
    assert "agent-fleet-operations" in project_creation
    assert "references/pm-deployment.md" in project_creation
