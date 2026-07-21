# Cache Sync Policy

The source repository is canonical for LP-Flow.

The installed Codex cache is a disposable installation target. Cache contents
are useful for execution, but cache-only files are not authoritative and must
not be used as source-of-truth documentation, examples, or workflow behavior.

## Direction

Synchronize in one direction only:

```text
source repository -> installed cache
```

Do not promote cache changes back into source without an explicit review and a
separate source commit or patch.

## Purge Policy

When a file is removed from the source repository, the next explicit cache sync
must purge the corresponding cache file. Sync must not leave stale cache-only
copies that look like supported source files.

The cache must not contain:

- run outputs;
- validation datasets;
- generated viewer/story artifacts;
- built public viewer examples;
- downloaded scientific inputs;
- user task data;
- private profiles, credentials, SSH keys, or personal server paths.

Runtime assets that are intentionally shipped by source may be copied to cache,
but they must remain distinguishable from generated user outputs.

## Logging

Future cache syncs must be explicit and logged. A sync log should record:

- timestamp;
- source path;
- cache path;
- files copied or updated;
- files purged from cache;
- files intentionally skipped;
- validation checks performed after sync.

If a cache-only file is discovered outside an explicit sync log, treat it as a
stale installation artifact until proven otherwise.
