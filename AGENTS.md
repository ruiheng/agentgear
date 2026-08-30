# Maintainer Rules

- Keep canonical, agent-facing skill content under `skills/<name>/` only.
- Keep `SKILL.md` instructions in English, concise, and written for the executing agent.
- Before writing or reviewing agent-facing prompts, follow `skills/PROMPT-WRITING.md`.
- Keep runtime scripts inside their owning skill, written in JavaScript/Node.js. Put build, install, and test code outside `skills/`.
- Do not hand-edit `dist/`; regenerate it with `npm run build`.
- Put host-specific behavior in `providers/` only when the common Agent Skills payload cannot express it.
- Declare every new skill, pack, external command, and upstream dependency in `catalog/skills.json`.
- Run `npm run check` before publishing or copying a release.
