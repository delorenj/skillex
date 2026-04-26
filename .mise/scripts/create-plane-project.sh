#!/bin/bash
# =============================================================================
# create-plane-project.sh
# Creates a project in Plane and outputs the project ID
# =============================================================================
# Usage: ./scripts/create-plane-project.sh <workspace> <project_name> <identifier>
#
# Environment Variables:
#   PLANE_API_KEY - Required. Plane API key (get from Plane workspace settings)
#   PLANE_BASE_URL - Optional. Defaults to https://plane.delo.sh
#
# Output: Project ID (UUID) on success, non-zero exit on failure
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
WORKSPACE="${1:-}"
PROJECT_NAME="${2:-}"
PROJECT_IDENTIFIER="${3:-}"

# Validate arguments
if [[ -z "$WORKSPACE" ]] || [[ -z "$PROJECT_NAME" ]] || [[ -z "$PROJECT_IDENTIFIER" ]]; then
    echo -e "${RED}Error: Missing required arguments${NC}" >&2
    echo "Usage: $0 <workspace> <project_name> <identifier>" >&2
    echo "  workspace       - Plane workspace slug (e.g., 33god)" >&2
    echo "  project_name    - Display name for the project" >&2
    echo "  identifier      - 2+ char identifier for tickets (e.g., MYPRJ)" >&2
    exit 1
fi

# Validate identifier length
if [[ ${#PROJECT_IDENTIFIER} -lt 2 ]]; then
    echo -e "${RED}Error: Identifier must be at least 2 characters${NC}" >&2
    exit 1
fi

# Check for API key
if [[ -z "${PLANE_API_KEY:-}" ]]; then
    echo -e "${RED}Error: PLANE_API_KEY environment variable is not set${NC}" >&2
    echo "Get your API key from: https://plane.delo.sh/<workspace>/settings/api-tokens/" >&2
    exit 1
fi

# Configuration
PLANE_BASE_URL="${PLANE_BASE_URL:-https://plane.delo.sh}"

echo -e "${YELLOW}Creating Plane project...${NC}"
echo "  Workspace:   $WORKSPACE"
echo "  Name:       $PROJECT_NAME"
echo "  Identifier: $PROJECT_IDENTIFIER"

# Create project via Plane API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${PLANE_BASE_URL}/api/v1/workspaces/${WORKSPACE}/projects/" \
    -H "X-Api-Key: ${PLANE_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${PROJECT_NAME}\", \"identifier\": \"${PROJECT_IDENTIFIER}\"}")

# Parse response and HTTP code
HTTP_BODY=$(echo "$RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

# Check for errors
if [[ "$HTTP_CODE" -lt 200 ]] || [[ "$HTTP_CODE" -ge 300 ]]; then
    echo -e "${RED}Error: Plane API returned HTTP $HTTP_CODE${NC}" >&2
    echo "$HTTP_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('detail', d))" 2>/dev/null || echo "$HTTP_BODY" >&2
    exit 1
fi

# Extract project ID
PROJECT_ID=$(echo "$HTTP_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

echo -e "${GREEN}✓ Project created successfully${NC}"
echo -e "  Project ID: ${GREEN}${PROJECT_ID}${NC}"

# Output just the ID for piping
echo "$PROJECT_ID"
