# Development Guidelines & Rules

## File Length & Modularity Rule
1. **Target File Size Limit**: All code files (Python `.py`, JavaScript `.js`, CSS `.css`, HTML templates) must remain **under 400–500 lines** of code.
2. **Decomposition Over Accumulation**: Never append large handler blocks or unrelated logic into existing monolithic files. When a module approaches 400 lines, decompose it by functional domain (e.g., common utilities, domain routes, background services).
3. **Preserve Interface Stability**: When modularizing or splitting files, maintain clean top-level facades or re-exports (such as `backend/api_routes.py`) to guarantee backwards compatibility across imports and external scripts.
4. **Zero-Dependency Architecture**: SuperShare must remain completely free of external dependencies beyond Python standard libraries and `aiohttp`. No npm, webpack, or external frontend bundlers.
5. **No Direct Commits Without User Instruction**: Keep working tree changes unstaged and uncommitted unless explicitly instructed by the user to commit.

