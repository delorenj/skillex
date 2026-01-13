# skillex

**Claude Skills Management CLI** - Package and manage Claude AI skills with ease.

A Python-based command-line tool for packaging, listing, and organizing Claude AI skills. Automates the process of creating distributable ZIP archives from your skill directories.

## Features

- **Fast Packaging**: Package Claude skills into ZIP archives in seconds
- **Fuzzy Matching**: Use partial names to match skills (`agent` matches `agent-browser`, `ai-agent-sdk`, etc.)
- **Bulk Operations**: Package multiple skills at once with pattern matching
- **Beautiful Output**: Rich terminal formatting with colors, tables, and progress indicators
- **Type Safe**: Built with Python 3.12+ and strict type checking
- **Well Tested**: Comprehensive test suite with 85%+ coverage

## Requirements

- Python 3.12 or higher
- `uv` package manager (recommended) or `pip`
- Environment variable `$DC` set to your desired output directory

## Installation

### Using uv (recommended)

```bash
uv tool install skillex
```

### Using pip

```bash
pip install skillex
```

### Development installation

```bash
# Clone the repository
git clone https://github.com/delorenj/skillex.git
cd skillex

# Install with uv
uv sync

# Or install in editable mode
uv pip install -e ".[dev]"
```

## Quick Start

### Setup

Set the `$DC` environment variable (where packaged skills will be saved):

```bash
# Add to your ~/.zshrc or ~/.bashrc
export DC="$HOME/Documents"
```

### Package a skill

```bash
# Package a specific skill
skillex zip agent-browser

# Package all skills matching a pattern
skillex zip agent

# Package with verbose output
skillex zip agent -v
```

### List available skills

```bash
# List all skills
skillex list

# List skills matching a pattern
skillex list agent
```

## Usage

### Commands

**`skillex zip [PATTERN]`**

Package Claude skill(s) into ZIP archives.

- `PATTERN` (optional): Skill name pattern to match (case-insensitive)
- `-v, --verbose`: Show detailed output with file sizes and progress

**Examples:**
```bash
skillex zip agent-browser    # Package specific skill
skillex zip agent            # Package all matching skills
skillex zip -v my-skill      # Verbose output
```

**`skillex list [PATTERN]`**

List available Claude skills.

- `PATTERN` (optional): Filter skills by pattern

**Examples:**
```bash
skillex list          # List all skills
skillex list agent    # List skills matching "agent"
```

## Development

### Setup development environment

```bash
# Install dependencies
uv sync

# Install with dev dependencies
uv pip install -e ".[dev]"
```

### Run tests

```bash
# Run all tests with coverage
uv run pytest

# Run specific test file
uv run pytest tests/unit/test_discovery.py

# Run with verbose output
uv run pytest -v
```

### Code quality

```bash
# Lint and format with ruff
uv run ruff check .
uv run ruff format .

# Type check with mypy
uv run mypy src/skillex

# Run all checks
uv run ruff check . && uv run mypy src/skillex && uv run pytest
```

### Project Structure

```
skillex/
├── src/
│   └── skillex/
│       ├── __init__.py
│       ├── __main__.py
│       ├── cli.py              # CLI Layer
│       ├── services/           # Service Layer (Business Logic)
│       │   ├── discovery.py
│       │   ├── fuzzy.py
│       │   ├── packaging.py
│       │   └── validation.py
│       └── infrastructure/     # Infrastructure Layer (File Ops)
│           ├── filesystem.py
│           ├── zipbuilder.py
│           └── validator.py
├── tests/
│   ├── unit/                   # Unit tests
│   ├── integration/            # Integration tests
│   └── fixtures/               # Test fixtures
├── docs/                       # Documentation
├── pyproject.toml              # Project configuration
└── README.md
```

## Architecture

skillex follows a **Layered Architecture** pattern:

- **CLI Layer**: User interaction via typer, output formatting via rich
- **Service Layer**: Business logic for skill operations
- **Infrastructure Layer**: File system operations and ZIP archive creation

Key principles:
- Clear separation of concerns
- Type safety with strict mypy checking
- Comprehensive test coverage (≥85%)
- Security-first path validation

See `docs/architecture-skillex-2026-01-13.md` for complete architectural details.

## Configuration

skillex uses environment variables for configuration:

- `$DC`: Output directory for packaged skills (required)
  - Packaged skills saved to `$DC/skills/`
- Skills directory: `~/.claude/skills/` (hardcoded)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting (`uv run pytest && uv run ruff check .`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see LICENSE file for details.

## Author

Jarad DeLorenzo

## Acknowledgments

Built with:
- [typer](https://typer.tiangolo.com/) - CLI framework
- [rich](https://rich.readthedocs.io/) - Terminal formatting
- [uv](https://github.com/astral-sh/uv) - Fast Python package manager
