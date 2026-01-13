# Product Requirements Document: skillex

**Version:** 1.0
**Date:** 2026-01-13
**Project:** skillex - Claude Skills Management CLI
**Phase:** 2 - Planning
**Status:** Draft
**Product Manager:** Reverse Engineered from Implementation

---

## Executive Summary

**skillex** is a Python-based CLI tool designed to streamline the management and distribution of Claude AI skills. It provides developers and AI engineers with efficient commands to package, list, and organize Claude skills for sharing, backup, and deployment across development environments.

The tool addresses the pain point of manually managing Claude skill files by automating packaging workflows and providing visibility into the local skills ecosystem.

---

## Business Objectives

1. **Reduce Friction**: Eliminate manual zip creation and file organization for Claude skills
2. **Enable Sharing**: Facilitate easy skill distribution between developers and environments
3. **Improve Discoverability**: Provide quick visibility into available Claude skills
4. **Maintain Control**: Keep skill packaging simple, transparent, and user-controlled

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Time to package skill | < 5 seconds | CLI execution time |
| User adoption | 10+ active users | Installation count |
| Skill packaging accuracy | 100% | No corrupt/incomplete archives |
| Error rate | < 1% | Failed packaging operations |

---

## User Personas

### Primary: AI Developer
- **Role:** Software engineer building AI-powered applications
- **Goals:** Quickly package and share Claude skills across projects
- **Pain Points:** Manual zip creation, file path management, bulk operations
- **Technical Level:** High (comfortable with CLI tools, Python, environment variables)

### Secondary: DevOps Engineer
- **Role:** Infrastructure automation specialist
- **Goals:** Automate skill deployment and backup workflows
- **Pain Points:** Need scriptable, reliable packaging tools
- **Technical Level:** High (scripting, CI/CD pipelines)

---

## Functional Requirements

### FR-001: Skill Packaging Command

**Priority:** Must Have

**Description:**
System shall provide a `zip` command that packages Claude skill directories into distributable zip archives.

**Acceptance Criteria:**
- [ ] Command accepts skill name pattern as argument
- [ ] Creates zip file with skill name + `.zip` extension
- [ ] Outputs to `$DC/skills/` directory
- [ ] Zip contains relative paths (not absolute)
- [ ] Preserves directory structure within skill folder
- [ ] Returns success/failure status code

**Dependencies:** None

---

### FR-002: Fuzzy Skill Matching

**Priority:** Must Have

**Description:**
System shall support case-insensitive fuzzy matching for skill names, allowing partial pattern matching.

**Acceptance Criteria:**
- [ ] Pattern "agent" matches "agent-browser", "ai-agent-sdk", etc.
- [ ] Matching is case-insensitive
- [ ] Returns all matching skills sorted alphabetically
- [ ] Handles no matches gracefully with clear message

**Dependencies:** FR-001

---

### FR-003: Bulk Skill Packaging

**Priority:** Must Have

**Description:**
System shall package multiple skills when fuzzy match returns multiple results.

**Acceptance Criteria:**
- [ ] All matched skills are packaged automatically
- [ ] Displays list of matched skills before packaging
- [ ] Shows progress for each skill being packaged
- [ ] Provides summary count of successful packages
- [ ] Continues packaging remaining skills if one fails

**Dependencies:** FR-001, FR-002

---

### FR-004: Skills Directory Discovery

**Priority:** Must Have

**Description:**
System shall automatically discover Claude skills from standard directory `~/.claude/skills/`.

**Acceptance Criteria:**
- [ ] Reads from `~/.claude/skills/` directory
- [ ] Validates directory exists before operations
- [ ] Identifies skill directories (not files)
- [ ] Provides clear error if directory not found

**Dependencies:** None

---

### FR-005: Output Directory Configuration

**Priority:** Must Have

**Description:**
System shall output packaged skills to `$DC/skills/` directory, creating it if needed.

**Acceptance Criteria:**
- [ ] Reads `$DC` environment variable
- [ ] Creates `$DC/skills/` directory if missing
- [ ] Validates `$DC` is set before operations
- [ ] Provides clear error message if `$DC` not configured

**Dependencies:** FR-001

---

### FR-006: List Available Skills

**Priority:** Must Have

**Description:**
System shall provide a `list` command to display all available Claude skills.

**Acceptance Criteria:**
- [ ] Lists all skills in `~/.claude/skills/`
- [ ] Displays in formatted table with skill name and path
- [ ] Shows total skill count
- [ ] Sorts alphabetically by skill name

**Dependencies:** FR-004

---

### FR-007: Filter Skills List

**Priority:** Should Have

**Description:**
System shall allow optional pattern argument to filter skills in list command.

**Acceptance Criteria:**
- [ ] `skillex list agent` shows only matching skills
- [ ] Uses same fuzzy matching as zip command
- [ ] Shows "no matches" message if pattern finds nothing
- [ ] Displays filtered count in summary

**Dependencies:** FR-006, FR-002

---

### FR-008: Verbose Output Mode

**Priority:** Should Have

**Description:**
System shall provide verbose flag (`-v`, `--verbose`) to show detailed packaging information.

**Acceptance Criteria:**
- [ ] Shows file size for each created zip
- [ ] Displays detailed progress during packaging
- [ ] Provides additional diagnostic information
- [ ] Available for zip command

**Dependencies:** FR-001

---

### FR-009: Rich Terminal Output

**Priority:** Should Have

**Description:**
System shall provide colored, formatted terminal output for improved readability.

**Acceptance Criteria:**
- [ ] Uses colors to indicate success (green), errors (red), info (cyan)
- [ ] Formats tables with borders and alignment
- [ ] Displays checkmarks/symbols for visual feedback
- [ ] Degrades gracefully in non-color terminals

**Dependencies:** None

---

### FR-010: Error Handling and Recovery

**Priority:** Must Have

**Description:**
System shall handle errors gracefully and provide actionable error messages.

**Acceptance Criteria:**
- [ ] Validates environment variables before operations
- [ ] Checks file system permissions
- [ ] Handles missing directories
- [ ] Provides specific error messages (not generic exceptions)
- [ ] Returns appropriate exit codes for automation

**Dependencies:** All FRs

---

### FR-011: Package Structure Validation

**Priority:** Must Have

**Description:**
System shall create valid zip archives with proper internal structure.

**Acceptance Criteria:**
- [ ] Archive uses relative paths from skills parent directory
- [ ] Maintains skill directory as top-level folder in zip
- [ ] Uses ZIP_DEFLATED compression
- [ ] Creates valid archives readable by standard unzip tools

**Dependencies:** FR-001

---

### FR-012: CLI Installation via uv

**Priority:** Must Have

**Description:**
System shall be installable as a Python CLI tool using `uv tool install`.

**Acceptance Criteria:**
- [ ] Installable via `uv tool install skillex`
- [ ] Supports editable install: `uv tool install -e .`
- [ ] Registers `skillex` command in PATH
- [ ] Uses hatchling build backend
- [ ] Requires Python 3.12+

**Dependencies:** None

---

## Non-Functional Requirements

### NFR-001: Performance - Packaging Speed

**Priority:** Must Have

**Description:**
Skill packaging operations shall complete quickly to support iterative workflows.

**Acceptance Criteria:**
- [ ] Single skill packaging completes in < 5 seconds for typical skills (< 50MB)
- [ ] Bulk packaging processes skills concurrently where possible
- [ ] No unnecessary file system scans

**Rationale:**
Developers need fast feedback loops when preparing skills for distribution.

---

### NFR-002: Reliability - Data Integrity

**Priority:** Must Have

**Description:**
Packaged skills shall maintain complete file integrity with no data loss or corruption.

**Acceptance Criteria:**
- [ ] 100% of files in source directory included in zip
- [ ] Zip archives pass integrity checks (`zip -T`)
- [ ] File permissions preserved where supported
- [ ] No silent failures during packaging

**Rationale:**
Skills must be reliably shareable without risk of missing files breaking functionality.

---

### NFR-003: Usability - Developer Experience

**Priority:** Must Have

**Description:**
CLI shall provide intuitive commands and helpful error messages for self-service usage.

**Acceptance Criteria:**
- [ ] Commands follow standard CLI conventions (verb-noun pattern)
- [ ] Built-in help via `--help` flag
- [ ] Error messages suggest corrective actions
- [ ] Visual feedback for long-running operations

**Rationale:**
Tool should be immediately usable without extensive documentation reference.

---

### NFR-004: Compatibility - Environment Support

**Priority:** Must Have

**Description:**
Tool shall work across common development environments with minimal configuration.

**Acceptance Criteria:**
- [ ] Works on Linux, macOS, WSL
- [ ] Requires only Python 3.12+ and standard libraries
- [ ] Uses environment variables for configuration (no config files required)
- [ ] Handles different terminal types (color/no-color)

**Rationale:**
Developers work in varied environments and expect tools to work consistently.

---

### NFR-005: Maintainability - Code Quality

**Priority:** Should Have

**Description:**
Codebase shall follow Python best practices for long-term maintainability.

**Acceptance Criteria:**
- [ ] Type hints on all functions
- [ ] Docstrings for public API
- [ ] Clear separation of concerns (CLI, business logic, file operations)
- [ ] Minimal external dependencies (typer, rich only)

**Rationale:**
Simple, well-structured code reduces maintenance burden and onboarding friction.

---

### NFR-006: Security - Path Validation

**Priority:** Must Have

**Description:**
Tool shall validate and sanitize file paths to prevent directory traversal attacks.

**Acceptance Criteria:**
- [ ] Validates skills directory is within expected location
- [ ] Prevents packaging files outside skills directory
- [ ] Sanitizes skill names before file system operations
- [ ] No arbitrary path traversal via pattern injection

**Rationale:**
Tool operates on file system with user-controlled inputs requiring security validation.

---

## Epics

### EPIC-001: Core Skill Packaging

**Description:**
Implement fundamental skill packaging workflow: discover, match, zip, and save skills.

**Functional Requirements:**
- FR-001: Skill Packaging Command
- FR-002: Fuzzy Skill Matching
- FR-003: Bulk Skill Packaging
- FR-004: Skills Directory Discovery
- FR-005: Output Directory Configuration
- FR-011: Package Structure Validation

**Story Count Estimate:** 5-7 stories

**Priority:** Must Have

**Business Value:**
Core value proposition. Enables basic skill distribution workflow.

---

### EPIC-002: Skill Discovery and Visibility

**Description:**
Provide tools to list, filter, and discover available Claude skills in local environment.

**Functional Requirements:**
- FR-006: List Available Skills
- FR-007: Filter Skills List

**Story Count Estimate:** 2-3 stories

**Priority:** Must Have

**Business Value:**
Improves developer workflow by surfacing available skills before packaging operations.

---

### EPIC-003: Enhanced User Experience

**Description:**
Improve CLI usability through rich output, verbose modes, and helpful feedback.

**Functional Requirements:**
- FR-008: Verbose Output Mode
- FR-009: Rich Terminal Output
- FR-010: Error Handling and Recovery

**Story Count Estimate:** 3-4 stories

**Priority:** Should Have

**Business Value:**
Reduces friction, improves debugging, and creates professional developer experience.

---

### EPIC-004: Installation and Distribution

**Description:**
Package and distribute skillex as installable Python CLI tool via uv/pip.

**Functional Requirements:**
- FR-012: CLI Installation via uv

**Story Count Estimate:** 2-3 stories

**Priority:** Must Have

**Business Value:**
Enables easy adoption and deployment across development teams.

---

## High-Level User Stories

### Epic 001 Stories

**Story 1.1:** As an AI developer, I want to package a single Claude skill into a zip file so that I can share it with teammates.

**Story 1.2:** As an AI developer, I want the tool to automatically find skills by partial name match so that I don't need to type exact names.

**Story 1.3:** As a DevOps engineer, I want to package multiple skills matching a pattern in one command so that I can automate bulk operations.

**Story 1.4:** As an AI developer, I want packaged skills saved to a configurable location so that I can integrate with my existing file organization.

---

### Epic 002 Stories

**Story 2.1:** As an AI developer, I want to see a list of all available Claude skills so that I know what I can package.

**Story 2.2:** As an AI developer, I want to filter the skills list by pattern so that I can quickly find specific skills.

---

### Epic 003 Stories

**Story 3.1:** As an AI developer, I want colored terminal output so that I can quickly identify success/failure states.

**Story 3.2:** As an AI developer, I want verbose mode to show file sizes and details so that I can verify packaging results.

**Story 3.3:** As an AI developer, I want clear error messages when something goes wrong so that I can fix configuration issues myself.

---

### Epic 004 Stories

**Story 4.1:** As an AI developer, I want to install skillex via `uv tool install` so that it's available in my CLI environment.

**Story 4.2:** As a package maintainer, I want skillex to use hatchling so that it follows modern Python packaging standards.

---

## User Flows

### Flow 1: Package Single Skill

```
User → skillex zip agent-browser
System → Validates $DC environment variable
System → Checks ~/.claude/skills/agent-browser exists
System → Creates $DC/skills/agent-browser.zip
System → Displays success message with output path
User → Receives zip file ready for distribution
```

### Flow 2: Discover and Package Multiple Skills

```
User → skillex list agent
System → Displays table of skills matching "agent"
User → skillex zip agent
System → Shows matched skills (agent-browser, ai-agent-sdk, etc.)
System → Packages each skill
System → Displays summary: "Packaged 3 skills"
User → Receives multiple zip files
```

### Flow 3: Handle Configuration Error

```
User → skillex zip my-skill
System → Checks for $DC environment variable
System → $DC not set
System → Displays error: "$DC environment variable is not set"
System → Exits with error code 1
User → Sets $DC and retries
```

---

## Traceability Matrix

| Epic ID | Epic Name | Functional Requirements | Story Estimate |
|---------|-----------|-------------------------|----------------|
| EPIC-001 | Core Skill Packaging | FR-001, FR-002, FR-003, FR-004, FR-005, FR-011 | 5-7 stories |
| EPIC-002 | Skill Discovery | FR-006, FR-007 | 2-3 stories |
| EPIC-003 | Enhanced UX | FR-008, FR-009, FR-010 | 3-4 stories |
| EPIC-004 | Installation | FR-012 | 2-3 stories |

**Total Requirements:** 12 FRs, 6 NFRs
**Total Epics:** 4
**Estimated Stories:** 12-17

---

## Prioritization Summary

### Must Have (MVP Blockers)
- **Functional:** 9 FRs (FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-010, FR-011, FR-012)
- **Non-Functional:** 5 NFRs (NFR-001, NFR-002, NFR-003, NFR-004, NFR-006)
- **Epics:** EPIC-001, EPIC-002, EPIC-004

### Should Have (High Value)
- **Functional:** 3 FRs (FR-007, FR-008, FR-009)
- **Non-Functional:** 1 NFR (NFR-005)
- **Epics:** EPIC-003

### Could Have
- None identified at this time

---

## Dependencies

### Internal Dependencies
- `$DC` environment variable must be configured in user shell
- Claude skills must exist in `~/.claude/skills/` directory
- Python 3.12+ installed
- `uv` package manager installed

### External Dependencies
- **typer** (>=0.12.0): CLI framework
- **rich** (>=13.0.0): Terminal formatting

### System Dependencies
- Python 3.12+
- Access to file system for read/write operations
- Standard Unix-like shell environment

---

## Assumptions

1. Users have Claude skills installed in standard location (`~/.claude/skills/`)
2. Users understand and use environment variables
3. Skills are self-contained directories (no external symlinks)
4. `$DC` environment variable points to valid writable directory
5. Users have basic CLI proficiency
6. Network access not required (local-only operations)

---

## Out of Scope

### Version 1.0 Exclusions

1. **Skill Installation:** Tool does not install skills from zip files (packaging only)
2. **Remote Operations:** No upload to cloud storage or skill repositories
3. **Skill Validation:** Does not verify skill structure/correctness
4. **Version Management:** No skill versioning or changelog tracking
5. **Authentication:** No user accounts or access control
6. **Skill Editing:** No in-place skill modification capabilities
7. **Configuration Files:** No persistent config (environment variables only)
8. **GUI:** CLI-only tool (no graphical interface)
9. **Skill Search:** No semantic search or metadata indexing
10. **Cross-Platform Packaging:** Does not handle platform-specific skill variations

---

## Open Questions

1. **Compression Level:** Should we expose zip compression level as option, or default to DEFLATED sufficient?
   - **Resolution:** Default to DEFLATED (good balance). Add option only if users request.

2. **Overwrite Behavior:** What should happen if zip file already exists in destination?
   - **Current:** Silently overwrites
   - **Consider:** Add `--no-clobber` flag in future version

3. **Skill Metadata:** Should we extract/display skill metadata (from SKILL.md) in list command?
   - **Defer:** Add in v2.0 if user demand exists

4. **Parallel Packaging:** Should bulk packaging use multiprocessing for speed?
   - **Current:** Sequential processing
   - **Consider:** Profile with large skill sets first

---

## Stakeholders

| Role | Name | Involvement |
|------|------|-------------|
| Developer/Creator | Jarad DeLorenzo | Implementation, design decisions |
| Primary User | AI Developers | Daily usage, feedback |
| Secondary User | DevOps Engineers | Automation integration |

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-13 | PRD Generator | Initial PRD reverse-engineered from implementation |

---

## Next Steps

### Recommended Workflow

✓ **PRD Complete**

**Next: Architecture Design**

Run `/bmad:architecture` to design system architecture that implements these requirements.

**Why Architecture?**
With 12 functional requirements and 4 epics, architectural planning ensures:
- Clean separation of CLI, business logic, and file operations
- Testable, maintainable code structure
- Clear module boundaries for future extensibility
- Proper error handling patterns

The project is currently **implemented** but would benefit from formal architecture documentation for maintainability and team onboarding.

---

## Appendix

### Technology Stack

- **Language:** Python 3.12+
- **CLI Framework:** Typer
- **Terminal Output:** Rich
- **Build System:** Hatchling
- **Package Manager:** uv
- **Archive Format:** ZIP (zipfile standard library)

### Project Structure

```
skillex/
├── src/skillex/
│   ├── __init__.py          # Package metadata
│   ├── __main__.py          # Module entry point
│   └── cli.py               # CLI commands and logic
├── docs/
│   └── prd-skillex-*.md     # This document
├── pyproject.toml           # Project configuration
└── README.md                # User documentation
```
