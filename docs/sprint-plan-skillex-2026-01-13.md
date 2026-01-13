# Sprint Plan: skillex

**Date:** 2026-01-13
**Scrum Master:** Jarad DeLorenzo
**Project Level:** 2 (Medium: 5-15 stories)
**Total Stories:** 14
**Total Points:** 54 points
**Planned Sprints:** 2

---

## Executive Summary

This sprint plan breaks down the skillex CLI tool into 14 user stories across 2 two-week sprints. The project follows a layered architecture (CLI → Service → Infrastructure) with clear component boundaries. Sprint 1 focuses on core packaging functionality and infrastructure setup. Sprint 2 delivers discovery, enhanced UX features, and installation/distribution capabilities.

**Key Metrics:**
- Total Stories: 14
- Total Points: 54
- Sprints: 2
- Team Capacity: 30 points per sprint
- Sprint Length: 2 weeks
- Team: 1 senior developer
- Target Completion: 2026-02-10 (4 weeks from start)

---

## Story Inventory

### STORY-000: Project Setup and Infrastructure

**Epic:** Infrastructure
**Priority:** Must Have

**User Story:**
As a developer
I want the project structure and development environment set up
So that I can begin implementing features with proper tooling

**Acceptance Criteria:**
- [ ] Project directory structure matches architecture (`src/skillex/`, `tests/`, etc.)
- [ ] `pyproject.toml` configured with hatchling, uv, dependencies (typer, rich)
- [ ] Development tools configured (ruff, mypy, pytest)
- [ ] Git repository initialized with `.gitignore`
- [ ] README.md with quick start guide
- [ ] CI/CD GitHub Actions workflow (lint, type check, test)

**Technical Notes:**
- Follow architecture document structure precisely
- Configure mypy in strict mode
- Set pytest coverage target to 85%+
- Use uv for dependency management

**Dependencies:** None

**Story Points:** 3

---

### STORY-001: File System Manager (Infrastructure Layer)

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a developer
I want a File System Manager component
So that all file operations are abstracted and testable

**Acceptance Criteria:**
- [ ] `FileSystemManager` class created in `src/skillex/infrastructure/filesystem.py`
- [ ] Methods: `list_directory()`, `check_exists()`, `get_metadata()`, `create_directory()`
- [ ] Uses `pathlib.Path` for cross-platform compatibility
- [ ] Comprehensive error handling with specific exceptions
- [ ] Unit tests with 90%+ coverage
- [ ] All paths resolved to absolute internally

**Technical Notes:**
- Component from architecture: Infrastructure Layer Component 6
- No dependencies on Service Layer
- Pure file operations only

**Dependencies:** STORY-000

**Story Points:** 3

---

### STORY-002: Path Validator (Security)

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a developer
I want path validation to prevent directory traversal attacks
So that the tool operates securely with user-controlled inputs

**Acceptance Criteria:**
- [ ] `PathValidator` class created in `src/skillex/infrastructure/validator.py`
- [ ] Method: `validate_path(path, allowed_base)` returns validated absolute path or raises `SecurityError`
- [ ] Uses `Path.resolve()` to canonicalize paths
- [ ] Validates resolved path is child of allowed base
- [ ] Security tests: Attempt traversal with `../`, absolute paths, symlinks
- [ ] Fuzzing tests with random input patterns

**Technical Notes:**
- Component from architecture: Infrastructure Layer Component 8
- Critical security component (NFR-006)
- Must raise clear exceptions on invalid paths

**Dependencies:** STORY-001

**Story Points:** 3

---

### STORY-003: ZIP Archive Builder

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a developer
I want a ZIP Archive Builder component
So that skills can be packaged reliably with proper structure

**Acceptance Criteria:**
- [ ] `ZipArchiveBuilder` class created in `src/skillex/infrastructure/zipbuilder.py`
- [ ] Method: `create_archive(source_dir, output_path)` returns path to created archive
- [ ] Uses `ZIP_DEFLATED` compression
- [ ] Atomic operations: temp file → rename on success
- [ ] Relative paths from skill parent directory (not absolute paths)
- [ ] No symlink following (security)
- [ ] ZIP integrity validation after creation
- [ ] Unit tests: Verify all files included, relative paths, compression

**Technical Notes:**
- Component from architecture: Infrastructure Layer Component 7
- Addresses NFR-002 (Data Integrity)
- Must handle large files efficiently (streaming)

**Dependencies:** STORY-001, STORY-002

**Story Points:** 5

---

### STORY-004: Environment Configuration

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a user
I want the tool to read my `$DC` environment variable
So that packaged skills are saved to my configured output directory

**Acceptance Criteria:**
- [ ] `EnvironmentConfig` class created in `src/skillex/infrastructure/`
- [ ] `Config` dataclass with `skills_directory` and `output_directory` paths
- [ ] `Config.from_environment()` reads `$DC` env var
- [ ] Defaults: skills = `~/.claude/skills/`, output = `$DC/skills/`
- [ ] Fails fast with clear error if `$DC` not set
- [ ] Immutable config object
- [ ] Unit tests: Mock environment, test defaults, test missing $DC

**Technical Notes:**
- Component from architecture: Infrastructure Layer Component 9
- Addresses FR-005 (Output Directory Configuration)
- Config is singleton per runtime

**Dependencies:** STORY-001

**Story Points:** 2

---

### STORY-005: Skill Discovery Service

**Epic:** EPIC-002 (Skill Discovery)
**Priority:** Must Have

**User Story:**
As a user
I want the tool to automatically discover my Claude skills
So that I don't have to manually specify paths

**Acceptance Criteria:**
- [ ] `SkillDiscoveryService` class created in `src/skillex/services/discovery.py`
- [ ] `SkillInfo` dataclass (name, path, size_bytes, file_count)
- [ ] Method: `discover_all()` returns `List[SkillInfo]`
- [ ] Reads from `~/.claude/skills/` directory
- [ ] Identifies directories only (not files)
- [ ] Returns empty list if directory doesn't exist (no error)
- [ ] Caches results within single command execution
- [ ] Unit tests with mock file system

**Technical Notes:**
- Component from architecture: Service Layer Component 2
- Addresses FR-004 (Skills Directory Discovery)
- No recursive scanning - top-level only

**Dependencies:** STORY-001, STORY-004

**Story Points:** 3

---

### STORY-006: Fuzzy Matcher Service

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a user
I want to use partial names to match skills
So that I don't have to type exact skill names

**Acceptance Criteria:**
- [ ] `FuzzyMatcherService` class created in `src/skillex/services/fuzzy.py`
- [ ] Method: `match(pattern, skills)` returns filtered and sorted `List[SkillInfo]`
- [ ] Case-insensitive substring matching (`.lower()`)
- [ ] Returns matches in alphabetical order
- [ ] Empty pattern matches all skills
- [ ] No regex support in v1.0 (simple matching only)
- [ ] Unit tests: Various patterns, edge cases, empty results

**Technical Notes:**
- Component from architecture: Service Layer Component 3
- Addresses FR-002 (Fuzzy Skill Matching)
- Pure logic component (no external dependencies)

**Dependencies:** STORY-005

**Story Points:** 2

---

### STORY-007: Packaging Service (Core Orchestration)

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a user
I want to package skills by pattern
So that I can create distributable ZIP archives

**Acceptance Criteria:**
- [ ] `PackagingService` class created in `src/skillex/services/packaging.py`
- [ ] `PackagingResult` dataclass (successful, failed, total_skills, total_size_bytes, duration_seconds)
- [ ] Method: `package_skills(pattern, verbose)` returns `PackagingResult`
- [ ] Coordinates: discovery → matching → archiving
- [ ] Handles bulk packaging (loops over multiple skills)
- [ ] Continues packaging on individual skill failure
- [ ] Progress indication via rich progress bar (if verbose)
- [ ] Integration tests with temporary directories

**Technical Notes:**
- Component from architecture: Service Layer Component 4
- Addresses FR-001, FR-003 (Skill Packaging, Bulk Packaging)
- Single-threaded (no concurrency in v1.0)

**Dependencies:** STORY-003, STORY-005, STORY-006

**Story Points:** 5

---

### STORY-008: Validation Service

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a developer
I want comprehensive validation of inputs and operations
So that errors are caught early with clear messages

**Acceptance Criteria:**
- [ ] `ValidationService` class created in `src/skillex/services/validation.py`
- [ ] `ValidationResult` dataclass (is_valid, errors, warnings)
- [ ] Methods: `validate_environment()`, `validate_paths()`, `validate_skill_name()`
- [ ] Called before any file operations
- [ ] Returns actionable error messages
- [ ] No side effects (pure validation)
- [ ] Unit tests for all validation scenarios

**Technical Notes:**
- Component from architecture: Service Layer Component 5
- Addresses FR-010 (Error Handling)
- Uses PathValidator for path checks

**Dependencies:** STORY-002, STORY-004

**Story Points:** 3

---

### STORY-009: CLI - Zip Command

**Epic:** EPIC-001 (Core Skill Packaging)
**Priority:** Must Have

**User Story:**
As a user
I want to run `skillex zip <pattern>` command
So that I can package Claude skills into ZIP archives

**Acceptance Criteria:**
- [ ] `skillex zip` command implemented in `src/skillex/cli.py`
- [ ] Accepts optional `[PATTERN]` argument
- [ ] Flags: `-v/--verbose` for detailed output
- [ ] Calls PackagingService orchestration
- [ ] Displays success summary with paths (green)
- [ ] Displays errors in red with exit code 1
- [ ] Shows rich table for verbose mode
- [ ] Integration tests: End-to-end CLI testing

**Technical Notes:**
- Component from architecture: CLI Layer Component 1
- Addresses FR-001, FR-008 (Packaging Command, Verbose Mode)
- Uses typer for command parsing, rich for output

**Dependencies:** STORY-007, STORY-008

**Story Points:** 5

---

### STORY-010: CLI - List Command

**Epic:** EPIC-002 (Skill Discovery)
**Priority:** Must Have

**User Story:**
As a user
I want to run `skillex list [pattern]` command
So that I can see available Claude skills

**Acceptance Criteria:**
- [ ] `skillex list` command implemented in `src/skillex/cli.py`
- [ ] Accepts optional `[PATTERN]` argument for filtering
- [ ] Displays rich table: Skill Name, Path, Size
- [ ] Shows summary: "Found X skills"
- [ ] Sorts alphabetically by skill name
- [ ] Filters using FuzzyMatcherService if pattern provided
- [ ] Exit code 0 on success, 1 if skills directory not found
- [ ] Integration tests: List all, list with filter, empty results

**Technical Notes:**
- Component from architecture: CLI Layer Component 1
- Addresses FR-006, FR-007 (List Skills, Filter List)
- Uses rich table formatting

**Dependencies:** STORY-005, STORY-006

**Story Points:** 3

---

### STORY-011: Rich Terminal Output Enhancement

**Epic:** EPIC-003 (Enhanced UX)
**Priority:** Should Have

**User Story:**
As a user
I want beautiful, color-coded terminal output
So that I can quickly understand success/failure states

**Acceptance Criteria:**
- [ ] `OutputFormatter` utility class in `src/skillex/cli.py`
- [ ] Color scheme: green=success, red=error, cyan=info, yellow=warning
- [ ] Rich tables with borders and alignment
- [ ] Progress bars for long operations
- [ ] Checkmarks/symbols for visual feedback
- [ ] Graceful degradation for non-color terminals
- [ ] Consistent formatting across all commands

**Technical Notes:**
- Component from architecture: CLI Layer enhancement
- Addresses FR-009 (Rich Terminal Output)
- Uses rich library features (console, table, progress)

**Dependencies:** STORY-009, STORY-010

**Story Points:** 3

---

### STORY-012: Comprehensive Error Handling

**Epic:** EPIC-003 (Enhanced UX)
**Priority:** Must Have

**User Story:**
As a user
I want clear, actionable error messages when something goes wrong
So that I can fix configuration issues myself

**Acceptance Criteria:**
- [ ] All error paths have specific error messages (not generic exceptions)
- [ ] Error message format: "Problem description. Suggested fix."
- [ ] Validation errors show what's wrong and how to fix
- [ ] File system errors are caught and explained
- [ ] Environment variable errors suggest setting $DC
- [ ] Exit codes: 0=success, 1=failure
- [ ] Error handling tests for all error scenarios

**Technical Notes:**
- Addresses FR-010 (Error Handling and Recovery)
- Cross-cutting concern across all layers
- Every tool call should have error handling

**Dependencies:** All service and infrastructure stories

**Story Points:** 3

---

### STORY-013: Testing Suite and Coverage

**Epic:** EPIC-003 (Enhanced UX) / Infrastructure
**Priority:** Must Have

**User Story:**
As a developer
I want comprehensive test coverage with clear test organization
So that the codebase is maintainable and changes are safe

**Acceptance Criteria:**
- [ ] Test structure: `tests/unit/`, `tests/integration/`, `tests/fixtures/`
- [ ] Unit tests for all services and infrastructure (90%+ coverage)
- [ ] Integration tests for CLI commands (end-to-end)
- [ ] Property-based tests for path validation (hypothesis)
- [ ] pytest fixtures: `tmp_skills_dir`, `tmp_output_dir`, `sample_skill`, `mock_config`
- [ ] Overall coverage ≥85%
- [ ] All tests passing in CI/CD

**Technical Notes:**
- Addresses NFR-005 (Maintainability - Code Quality)
- Architecture specifies 85%+ coverage target
- Use pytest with coverage plugin

**Dependencies:** All implementation stories

**Story Points:** 5

---

### STORY-014: Package and Publish to PyPI

**Epic:** EPIC-004 (Installation and Distribution)
**Priority:** Must Have

**User Story:**
As a user
I want to install skillex via `uv tool install skillex`
So that it's available as a global CLI command

**Acceptance Criteria:**
- [ ] `pyproject.toml` fully configured for packaging
- [ ] Hatchling build backend setup
- [ ] Project metadata complete (name, version, description, author, license)
- [ ] Entry point: `skillex = "skillex.cli:app"`
- [ ] GitHub Actions workflow: build → test → publish on tag
- [ ] Published to PyPI (or Test PyPI for initial release)
- [ ] Installation verified: `uv tool install skillex` works
- [ ] CLI command available in PATH after install

**Technical Notes:**
- Component from architecture: Development & Deployment
- Addresses FR-012 (CLI Installation via uv)
- Use semantic versioning (1.0.0)

**Dependencies:** STORY-000, STORY-013 (tests must pass)

**Story Points:** 3

---

## Sprint Allocation

### Sprint 1 (Weeks 1-2) - 27/30 points

**Goal:** Establish infrastructure and core packaging functionality

**Stories:**
- STORY-000: Project Setup and Infrastructure (3 points) - Infrastructure
- STORY-001: File System Manager (3 points) - Must Have
- STORY-002: Path Validator (3 points) - Must Have
- STORY-003: ZIP Archive Builder (5 points) - Must Have
- STORY-004: Environment Configuration (2 points) - Must Have
- STORY-005: Skill Discovery Service (3 points) - Must Have
- STORY-006: Fuzzy Matcher Service (2 points) - Must Have
- STORY-008: Validation Service (3 points) - Must Have
- STORY-007: Packaging Service (3 points) - Must Have *[Note: Partial implementation without CLI]*

**Total:** 27 points / 30 capacity (90% utilization)

**Deliverables:**
- Complete layered architecture implemented (Infrastructure + Service layers)
- All core business logic functional
- Unit tests for all services and infrastructure
- Security validation in place

**Risks:**
- Path validation complexity may extend testing effort
- ZIP archive integrity testing requires careful validation

**Dependencies:**
- `$DC` environment variable must be set by user
- `~/.claude/skills/` directory structure understood

---

### Sprint 2 (Weeks 3-4) - 27/30 points

**Goal:** Deliver complete CLI tool with enhanced UX and distribution capability

**Stories:**
- STORY-009: CLI - Zip Command (5 points) - Must Have
- STORY-010: CLI - List Command (3 points) - Must Have
- STORY-011: Rich Terminal Output Enhancement (3 points) - Should Have
- STORY-012: Comprehensive Error Handling (3 points) - Must Have
- STORY-013: Testing Suite and Coverage (5 points) - Must Have
- STORY-014: Package and Publish to PyPI (3 points) - Must Have
- STORY-007: Packaging Service - Complete (5 points) *[Finish integration with CLI]*

**Total:** 27 points / 30 capacity (90% utilization)

**Deliverables:**
- Fully functional CLI tool
- Beautiful terminal output with colors and tables
- Comprehensive test suite (≥85% coverage)
- Published to PyPI, installable via uv
- Complete user documentation

**Risks:**
- PyPI publishing may require account setup
- GitHub Actions workflow configuration complexity

**Dependencies:**
- Sprint 1 complete (all infrastructure and services)
- PyPI account and API token configured
- GitHub repository with Actions enabled

---

## Epic Traceability

| Epic ID | Epic Name | Stories | Total Points | Sprint(s) |
|---------|-----------|---------|--------------|-----------|
| Infrastructure | Project Setup | STORY-000 | 3 | Sprint 1 |
| EPIC-001 | Core Skill Packaging | STORY-001, 002, 003, 004, 006, 007, 008, 009 | 29 | Sprint 1-2 |
| EPIC-002 | Skill Discovery and Visibility | STORY-005, 010 | 6 | Sprint 1-2 |
| EPIC-003 | Enhanced User Experience | STORY-011, 012, 013 | 11 | Sprint 2 |
| EPIC-004 | Installation and Distribution | STORY-014 | 3 | Sprint 2 |

**Total:** 5 epics → 14 stories → 54 points → 2 sprints

---

## Functional Requirements Coverage

| FR ID | FR Name | Story | Sprint |
|-------|---------|-------|--------|
| FR-001 | Skill Packaging Command | STORY-009 | 2 |
| FR-002 | Fuzzy Skill Matching | STORY-006 | 1 |
| FR-003 | Bulk Skill Packaging | STORY-007 | 1-2 |
| FR-004 | Skills Directory Discovery | STORY-005 | 1 |
| FR-005 | Output Directory Configuration | STORY-004 | 1 |
| FR-006 | List Available Skills | STORY-010 | 2 |
| FR-007 | Filter Skills List | STORY-010 | 2 |
| FR-008 | Verbose Output Mode | STORY-009, 011 | 2 |
| FR-009 | Rich Terminal Output | STORY-011 | 2 |
| FR-010 | Error Handling and Recovery | STORY-008, 012 | 1-2 |
| FR-011 | Package Structure Validation | STORY-003 | 1 |
| FR-012 | CLI Installation via uv | STORY-014 | 2 |

**Coverage:** 12/12 FRs (100%)

---

## Risks and Mitigation

### High Risk

**Risk:** Path validation complexity leading to security vulnerabilities
- **Impact:** Critical security issue (NFR-006)
- **Probability:** Medium
- **Mitigation:**
  - Comprehensive security test suite with fuzzing
  - Property-based testing with hypothesis
  - Code review focused on path handling
  - Reference architecture security guidelines strictly

**Risk:** ZIP archive corruption on disk full scenario
- **Impact:** Data loss (NFR-002)
- **Probability:** Low
- **Mitigation:**
  - Atomic operations (temp file → rename)
  - Check available disk space before packaging
  - Delete incomplete archives on error
  - ZIP integrity validation after creation

### Medium Risk

**Risk:** `$DC` environment variable not set by users
- **Impact:** Tool cannot function
- **Probability:** High for new users
- **Mitigation:**
  - Clear error message with setup instructions
  - Documentation prominently shows setup steps
  - Consider auto-prompting for directory as fallback (v2.0)

**Risk:** GitHub Actions PyPI publishing configuration
- **Impact:** Cannot distribute tool
- **Probability:** Medium
- **Mitigation:**
  - Test with Test PyPI first
  - Follow uv publishing documentation closely
  - Manual publish for v1.0 if automated fails

### Low Risk

**Risk:** Large skills (>100MB) may be slow to package
- **Impact:** User frustration
- **Probability:** Low (most skills <50MB)
- **Mitigation:**
  - Progress bars provide feedback
  - Verbose mode shows per-file progress
  - Architecture designed for streaming (not loading to memory)

---

## Dependencies

### External Dependencies

**Runtime:**
- Python 3.12+ installed on user machine
- `typer` (>=0.12.0) - CLI framework
- `rich` (>=13.0.0) - Terminal output

**Development:**
- `pytest` (>=8.0.0) - Testing framework
- `mypy` - Type checking
- `ruff` - Linting and formatting
- `uv` - Package management

**Infrastructure:**
- GitHub repository with Actions enabled
- PyPI account with API token
- `$DC` environment variable configured by user

### Internal Dependencies (Story Order)

**Critical Path:**
1. STORY-000 (Project Setup) must complete before any other work
2. STORY-001 (File System Manager) blocks most infrastructure stories
3. STORY-003 (ZIP Builder) blocks STORY-007 (Packaging Service)
4. STORY-007 (Packaging Service) blocks STORY-009 (CLI Zip Command)
5. STORY-009 (CLI Commands) blocks STORY-013 (Testing Suite)
6. STORY-013 (Testing) blocks STORY-014 (Publish to PyPI)

**Parallel Work Opportunities:**
- STORY-002, 004 can be done in parallel with STORY-001
- STORY-005, 006 can be done in parallel
- STORY-011 (Output Enhancement) can be done alongside CLI commands

---

## Definition of Done

For a story to be considered complete:

- [ ] **Code Implemented:** All acceptance criteria met
- [ ] **Type Checked:** mypy strict mode passes with zero errors
- [ ] **Linted:** ruff check passes with zero violations
- [ ] **Unit Tests:** Written and passing (≥90% coverage for the story's code)
- [ ] **Integration Tests:** Written and passing (if applicable)
- [ ] **Code Reviewed:** Self-review against architecture document
- [ ] **Documentation:** Docstrings updated, README updated if needed
- [ ] **Manual Testing:** Feature tested manually in real environment
- [ ] **CI/CD Passing:** All GitHub Actions checks green

---

## Velocity Tracking

**Sprint 1 Planned:** 27 points
**Sprint 2 Planned:** 27 points

**After Sprint 1:**
- Actual points completed: ___ (to be filled)
- Velocity adjustment for Sprint 2: ___
- Burndown: ___

**After Sprint 2:**
- Actual points completed: ___
- Final velocity: ___
- Lessons learned: ___

---

## Team Agreements

**Working Hours:**
- 6 productive hours per day (senior developer)
- 10 workdays per sprint (2 weeks)

**Code Standards:**
- Follow layered architecture strictly (no layer violations)
- Type hints on all functions
- Google-style docstrings
- Test-first development encouraged

**Communication:**
- Daily progress tracking (personal)
- Sprint review at end of each sprint
- Sprint retrospective to adjust approach

**Tools:**
- `uv` for dependency management
- `ruff` for linting (replaces black, isort, flake8)
- `mypy --strict` for type checking
- `pytest` with coverage plugin

---

## Next Steps

### Immediate Action: Begin Sprint 1

**First Story:** STORY-000 (Project Setup and Infrastructure)

**Recommended approach:**
```bash
# Option 1: Create detailed story document first
/bmad:create-story STORY-000

# Option 2: Start implementing immediately
/bmad:dev-story STORY-000
```

**Sprint 1 Kickoff:**
1. Set up project structure following architecture
2. Configure development tools (mypy, ruff, pytest)
3. Initialize Git repository
4. Set up GitHub Actions CI/CD
5. Begin implementing infrastructure layer (STORY-001 onwards)

**Sprint Cadence:**
- Sprint 1: 2026-01-13 to 2026-01-27 (2 weeks)
- Sprint 2: 2026-01-27 to 2026-02-10 (2 weeks)
- Total duration: 4 weeks

**Target Completion:** 2026-02-10

---

## Appendix A: Story Sizing Reference

**1 point (1-2 hours):**
- Update configuration value
- Change text/copy
- Add simple validation

**2 points (2-4 hours):**
- Create basic service method
- Simple dataclass or model
- Basic unit test suite

**3 points (4-8 hours):**
- Service with business logic
- Infrastructure component
- Integration with other components
- Comprehensive test suite

**5 points (1-2 days):**
- Complex service with orchestration
- CLI command with multiple features
- Full component with tests
- Integration tests included

**8 points (2-3 days):**
- Complete feature (frontend + backend equivalent)
- Multiple related components
- Complex integration

---

## Appendix B: Architecture Layer Boundaries

**Strict Import Rules:**

**CLI Layer** (`src/skillex/cli.py`):
- ✓ Can import: `services/*`, `models.py`, `exceptions.py`
- ✗ Cannot import: `infrastructure/*`

**Service Layer** (`src/skillex/services/`):
- ✓ Can import: `infrastructure/*`, `models.py`, `exceptions.py`
- ✗ Cannot import: `cli.py`

**Infrastructure Layer** (`src/skillex/infrastructure/`):
- ✓ Can import: `models.py`, `exceptions.py`
- ✗ Cannot import: `cli.py`, `services/*`

**Enforcement:** Code review and import linting

---

**This plan was created using BMAD Method v6 - Phase 4 (Implementation Planning)**

*Run `/bmad:workflow-status` to see complete project progress.*
*Run `/bmad:sprint-status` to track sprint progress (after sprint begins).*
