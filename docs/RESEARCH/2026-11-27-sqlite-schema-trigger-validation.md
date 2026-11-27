# SQLite schema trigger validation

Date: 2026-11-27 UTC. Related tasks: ORB-004, ORB-005.

Official SQLite references: [schema table](https://sqlite.org/schematab.html) describes stored CREATE SQL and initial-keyword/object-name normalization; [CREATE TRIGGER](https://sqlite.org/lang_createtrigger.html) explains event and WHEN predicate behavior.

Decision: validate the entire expected generated trigger definition, accounting narrowly for the optional IF NOT EXISTS prefix. Do not strip comments, broadly normalize literals or treat arbitrary matching substrings as proof of equivalent behavior. Existing restart and new negative tests must establish compatibility with the Node 24 SQLite runtime via hosted CI. This detects schema drift at controlled initialization, not privileged tampering after startup.
