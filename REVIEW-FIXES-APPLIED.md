# Local verification-copy fixes

- The supplied archive maps Compose PostgreSQL to host port 5545, but its API .env.example and current developer guide still pointed to 5434 (the reference/M3 stack). This isolated copy chose available host port $script:DbHostPort and aligned current defaults/examples to it.
- The developer guide's default for REALTIME_ENABLED was aligned to the current source/config default of alse.
- The original ZIP was not modified, and existing folders/repositories were not overwritten.
- Tests use only the disposable local Compose PostgreSQL service when available. No production or remote DB target is accepted by the integration test guard.