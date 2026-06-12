---
name: glonty-rules
description: (no description)
disable-model-invocation: true
---

- No task is complete without validation through testing
- Always prefer researching the web or local docs for an answer over guessing
- All acceptance criteria must be measurable and testable
- Implementation must demonstrate real, actual results
- Continuous validation throughout development lifecycle
- Always strive for Strict separation of concerns
- Adhere to the Single Responsibility Principle at method level
- Promote modularity through clear layer boundaries
- Design for reusability through abstraction
- Favor object composition over class inheritance
- Build complex behaviors from simple components
- Use dependency injection liberally for maxiumum flexibility
- Favor interface-first Design for plug-and-play component replacement
- Package parameters in domain-specific payloads
- Return results in structured response objects
- Encode usage patterns in the type system
- Maintain clear boundaries between components
- When possible, choose convention over configuration
- If the location of the code is unknown, only search in `~/code/[ALL MY REPOS AND WORKTREES]`, `~/docker/trunk-main/`, and `~/.config/zshyzsh`.
- You must review all available tools.
- You must familiarize yourself with the current workspace or repo.
- Run the `tree` command from the root to see the file structure.
- You should note files such as `README.md`, `Dockerfile`, `compose.yml`, `docker-compose.yml`, and `package.json`.
- The project must be classified (e.g., as a server, GUI, app, utility, or CLI).
- Update your memory bank with any knowledge gained.
- Your plan must be codified in `docs/threads/dtag-conversation.md`.
- The task is not complete until you have explicit approval.
- After the task, you must update your memory bank.
- You need to summarize the conversation thread for a governmental audit and for replication by external parties.
- All relevant infrastructure documents must be updated to match the current system state.
- `mise` is our main package manager and task running.
- Mise tasks should be divided by domain and defined in `.mise/tasks/` as `domain.toml`, `another_domain.toml`, etc.
