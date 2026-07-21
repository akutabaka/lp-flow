Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PluginRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $NodeCommand -or -not $NodeCommand.Source) {
  throw 'Node.js 20 or newer was not found on PATH. Install Node.js before starting LP-Flow.'
}
$Node = $NodeCommand.Source

$Script = Join-Path $PluginRoot 'scripts\lp-flow.mjs'
& $Node $Script mcp
exit $LASTEXITCODE
