#!/bin/zsh

export SKILLEX_HOME="${SKILLEX_HOME:-$HOME/code/skillex}"
export SKILLS_AVAILABLE="$SKILLEX_HOME/all-skills/"
export SKILL_SETS_AVAILABLE="$SKILLEX_HOME/skill-sets/"
export SKILL_SET_GLOBAL="$SKILL_SETS_AVAILABLE/global/"

# Setting up globals
export AGENTS="$HOME/.agents"

if [[ -d "$AGENTS/skills" ]]; then
  mv "$AGENTS/skills" "$AGENTS/skills.bk"
fi

ln -sf $SKILL_SET_GLOBAL "$AGENTS/skills"


# Setting up sets
#
