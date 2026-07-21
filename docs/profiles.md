# Profiles

Profiles are private user configuration. They are not part of the LP-Flow source
release and must not be committed, archived, or included in scientific reports.

New profiles are discovered from `%USERPROFILE%\\.config\\lp-flow` on Windows
and `~/.config/lp-flow` on Unix-like systems. `LP_FLOW_DOCKING_CONFIG`,
`LP_FLOW_DOCKING_PROFILE_PATH`, and explicit tool arguments can select another
private profile.

`%APPDATA%\\LP-FlowDocking` is a legacy read-only discovery location for older
installations. LP-Flow does not create or write profiles there. Move active
profiles to the canonical location before a future major release removes legacy
discovery.
