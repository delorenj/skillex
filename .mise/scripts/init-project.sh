#!/bin/bash
# =============================================================================
# init-project.sh
# Orchestrates Plane project creation + Copier template rendering
# =============================================================================
# Usage: ./scripts/init-project.sh [--template <path>] [--non-interactive]
#
# This script:
#   1. Gathers project details (interactive or from args)
#   2. Creates a Plane project
#   3. Runs Copier with all answers pre-populated
#   4. Outputs next steps
# =============================================================================

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLANE_SCRIPT="${SCRIPT_DIR}/create-plane-project.sh"
TEMPLATE_URL="${TEMPLATE_URL:-gh:delorenj/CommonProject}"
DEFAULT_WORKSPACE="${DEFAULT_WORKSPACE:-33god}"

# Parse arguments
NON_INTERACTIVE=false
PROJECT_DIR=""
SKIP_PLANE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --template)
            TEMPLATE_URL="$2"
            shift 2
            ;;
        --non-interactive)
            NON_INTERACTIVE=true
            shift
            ;;
        --project-dir)
            PROJECT_DIR="$2"
            shift 2
            ;;
        --skip-plane)
            SKIP_PLANE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --template <path>    Copier template URL/path (default: ${TEMPLATE_URL})"
            echo "  --project-dir <dir>  Output directory (default: project name)"
            echo "  --non-interactive    Use defaults without prompting"
            echo "  --skip-plane         Skip Plane project creation"
            echo "  --help, -h           Show this help"
            echo ""
            echo "Environment Variables:"
            echo "  PLANE_API_KEY        Required for Plane project creation"
            echo "  PLANE_BASE_URL       Plane instance URL (default: https://plane.delo.sh)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║           33GOD Project Initialization Wizard              ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Function to prompt for input
prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default="$3"
    local result

    if [[ "$NON_INTERACTIVE" == true ]]; then
        result="$default"
        echo -e "${YELLOW}Using default:${NC} $result"
    else
        read -p "$prompt_text [$default]: " result
        result="${result:-$default}"
    fi
    printf -v "$var_name" '%s' "$result"
}

# Function to prompt for sensitive input (no echo)
prompt_secret() {
    local var_name="$1"
    local prompt_text="$2"
    local result

    if [[ "$NON_INTERACTIVE" == true ]]; then
        echo -e "${RED}Error: $prompt_text requires interactive mode${NC}" >&2
        exit 1
    fi
    read -sp "$prompt_text: " result
    echo ""
    printf -v "$var_name" '%s' "$result"
}

# =============================================================================
# Step 1: Gather Project Information
# =============================================================================
echo -e "${YELLOW}Step 1/4: Gather project information${NC}"
echo ""

prompt "PROJECT_NAME" "  Project name (e.g., HoloCron)" ""
if [[ -z "$PROJECT_NAME" ]]; then
    echo -e "${RED}Error: Project name is required${NC}"
    exit 1
fi

# Auto-generate slug from name
PROJECT_SLUG=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
echo "  Generated slug: $PROJECT_SLUG"

prompt "PROJECT_DESCRIPTION" "  Project description" ""
prompt "PROJECT_TYPE" "  Project type" "software" "software hardware dashboard tooling"
PROJECT_TYPE=$(echo "$PROJECT_TYPE" | tr '[:upper:]' '[:lower:]')

# =============================================================================
# Step 2: Gather Plane Information (if not skipped)
# =============================================================================
echo ""
echo -e "${YELLOW}Step 2/4: Plane configuration${NC}"
echo ""

if [[ "$SKIP_PLANE" == true ]]; then
    echo -e "${CYAN}Skipping Plane project creation (--skip-plane)${NC}"
    prompt "PLANE_WORKSPACE" "  Plane workspace" "$DEFAULT_WORKSPACE"
    prompt "PLANE_PROJECT_ID" "  Existing Plane project ID (UUID)" ""
    prompt "PROJECT_IDENTIFIER" "  Project identifier (e.g., ${PROJECT_SLUG:0:4} or ${PROJECT_NAME:0:4})" "${PROJECT_SLUG:0:4}"
else
    prompt "PLANE_WORKSPACE" "  Plane workspace" "$DEFAULT_WORKSPACE"
    prompt "PROJECT_IDENTIFIER" "  Project identifier (e.g., ${PROJECT_SLUG:0:4})" "${PROJECT_SLUG:0:4}"

    # Validate identifier
    if [[ ${#PROJECT_IDENTIFIER} -lt 2 ]]; then
        echo -e "${RED}Error: Identifier must be at least 2 characters${NC}"
        exit 1
    fi
    PROJECT_IDENTIFIER=$(echo "$PROJECT_IDENTIFIER" | tr '[:lower:]' '[:upper:]')

    # Check for API key
    if [[ -z "${PLANE_API_KEY:-}" ]]; then
        echo ""
        echo -e "${YELLOW}Note: PLANE_API_KEY not set. You'll need to create the Plane project manually.${NC}"
        prompt "PLANE_PROJECT_ID" "  Plane project ID (UUID, create at plane.delo.sh)" ""
    else
        echo ""
        echo -e "${GREEN}Creating Plane project...${NC}"
        PLANE_PROJECT_ID=$("$PLANE_SCRIPT" "$PLANE_WORKSPACE" "$PROJECT_NAME" "$PROJECT_IDENTIFIER" 2>&1)
        if [[ $? -ne 0 ]]; then
            echo -e "${RED}Failed to create Plane project${NC}" >&2
            echo "$PLANE_PROJECT_ID" >&2
            echo ""
            prompt "PLANE_PROJECT_ID" "  Enter Plane project ID manually" ""
        fi
    fi
fi

# =============================================================================
# Step 3: Gather Technical Stack
# =============================================================================
echo ""
echo -e "${YELLOW}Step 3/4: Technical configuration${NC}"
echo ""

prompt "PRIMARY_LANGUAGE" "  Primary language" "python" "python typescript rust mixed"
PRIMARY_LANGUAGE=$(echo "$PRIMARY_LANGUAGE" | tr '[:upper:]' '[:lower:]')

prompt "USES_DOCKER" "  Use Docker?" "y" "y n"
USES_DOCKER=$([[ "$USES_DOCKER" == "y" ]] && echo "true" || echo "false")

prompt "USES_EVENT_BUS" "  Use event bus (Bloodbank)?" "y" "y n"
USES_EVENT_BUS=$([[ "$USES_EVENT_BUS" == "y" ]] && echo "true" || echo "false")

prompt "INITIALIZE_GOD_DOCS" "  Initialize GOD docs?" "y" "y n"
INITIALIZE_GOD_DOCS=$([[ "$INITIALIZE_GOD_DOCS" == "y" ]] && echo "true" || echo "false")

# =============================================================================
# Step 4: Run Copier
# =============================================================================
echo ""
echo -e "${YELLOW}Step 4/4: Generate project from template${NC}"
echo ""

# Set output directory
OUTPUT_DIR="${PROJECT_DIR:-$PROJECT_SLUG}"

# Create answers file for Copier
ANSWERS_FILE=$(mktemp)
cat > "$ANSWERS_FILE" << EOF
{
    "project_name": "$PROJECT_NAME",
    "project_slug": "$PROJECT_SLUG",
    "project_description": "$PROJECT_DESCRIPTION",
    "project_type": "$PROJECT_TYPE",
    "plane_workspace": "$PLANE_WORKSPACE",
    "plane_project_id": "$PLANE_PROJECT_ID",
    "project_identifier": "$PROJECT_IDENTIFIER",
    "primary_language": "$PRIMARY_LANGUAGE",
    "uses_docker": $USES_DOCKER,
    "uses_event_bus": $USES_EVENT_BUS,
    "initialize_god_docs": $INITIALIZE_GOD_DOCS,
    "user_name": "Jarad",
    "user_skill_level": "intermediate",
    "has_hardware": false,
    "has_agent": true,
    "agent_name": "$PROJECT_NAME",
    "agent_role": "",
    "additional_services": "",
    "git_remote_url": "",
    "component_domain": "custom"
}
EOF

echo "Running Copier..."
echo ""

# Run Copier with answers
if copier copy "$TEMPLATE_URL" "$OUTPUT_DIR" --answers-file "$ANSWERS_FILE" --overwrite; then
    echo ""
    echo -e "${GREEN}✓ Project generated successfully!${NC}"
else
    echo ""
    echo -e "${RED}✗ Copier failed${NC}" >&2
    rm -f "$ANSWERS_FILE"
    exit 1
fi

# Cleanup
rm -f "$ANSWERS_FILE"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                     Project Ready!                        ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Project:${NC}   $PROJECT_NAME"
echo -e "  ${GREEN}Location:${NC}  ./$OUTPUT_DIR/"
echo -e "  ${GREEN}Type:${NC}     $PROJECT_TYPE"
echo ""
echo -e "  ${CYAN}Plane:${NC}     $PLANE_WORKSPACE/$PROJECT_IDENTIFIER"
echo -e "  ${CYAN}Project ID:${NC} $PLANE_PROJECT_ID"
echo ""

if [[ "$INITIALIZE_GOD_DOCS" == "true" ]]; then
    echo -e "${YELLOW}Next steps:${NC}"
    echo ""
    echo "  1. cd $OUTPUT_DIR"
    echo "  2. cp project.env.example .env"
    echo "  3. Edit .env with your API keys"
    echo "  4. git init && git add . && git commit -m 'Initial commit'"
    echo "  5. Create your first ticket in Plane: https://plane.delo.sh/$PLANE_WORKSPACE/projects/$PLANE_PROJECT_ID/"
else
    echo -e "${YELLOW}Next steps:${NC}"
    echo ""
    echo "  1. cd $OUTPUT_DIR"
    echo "  2. cp project.env.example .env"
    echo "  3. git init && git add . && git commit -m 'Initial commit'"
fi
echo ""
