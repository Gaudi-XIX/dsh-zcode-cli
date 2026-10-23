<#
.SYNOPSIS
    Write the environment variables ZCode 0.17.0 needs, at user scope.

.DESCRIPTION
    dsh-zcode-provider is fail-closed: it refuses to spawn the CLI unless the
    four ZCODE_* variables are set, and it never derives them on its own (a
    guessed path is how the CLI dies 714 ms in with a message far from the
    cause). NODE_OPTIONS is not required any more: the provider injects it into
    the child environment at spawn time.

    This script writes them to the *user* environment with
    [Environment]::SetEnvironmentVariable(name, value, 'User').

    Default behaviour is a dry run: it prints every key, the current value, the
    value it would write, and whether each path is present. -Apply is the only
    way anything is written. Existing NODE_OPTIONS is extended, never replaced:
    the two DNS flags are appended only when missing, so other flags the user
    set stay in place.

    -Apply never overwrites an existing value that differs from the plan: it
    prints a WARNING and skips that variable, so a user whose environment was
    tuned by hand (or by another tool) is not silently rewritten. Pass -Force to
    overwrite anyway.

    NODE_OPTIONS is optional here: the provider now builds the child environment
    itself (allowlist + injected NODE_OPTIONS), so the CLI still gets IPv4-first
    DNS without a user-scope variable. The entry is kept for interactive
    `zcode.cjs` runs outside DSH.

    A missing path is reported as a WARNING and does not abort: this script is
    not allowed to rearrange the live ZCode installation, and a dry run on a
    machine where ZCode lives elsewhere must still be readable.

    DSH reads the environment when it spawns the CLI, so the change takes effect
    only after DSH is restarted. This script never restarts anything.

.PARAMETER Apply
    Actually write the user-scope variables. Without it, the script is a dry run.

.PARAMETER Force
    With -Apply, overwrite a variable whose current value differs from the plan.
    Without it such a variable is reported as a WARNING and left untouched.

.EXAMPLE
    pwsh -File scripts/install-env.ps1
    # dry run: prints the plan, writes nothing

.EXAMPLE
    pwsh -File scripts/install-env.ps1 -Apply
    # writes the plan, then restart DSH
#>
[CmdletBinding()]
param(
    [switch]$Apply,

    [switch]$Force,

    [string]$ZcodeHome = 'F:\AgentData\zcode\data\.zcode',

    [string]$ZcodeDataBaseDir = 'F:\AgentData\zcode\data',

    [string]$BuiltinProviderConfigFile = 'F:\AgentData\zcode\cli\resources\config\provider\zcode-builtin.json',

    [string]$PersonalProviderConfigFile = 'F:\AgentData\zcode\data\.zcode\v2\provider_config.json',

    [string]$NodeOptions = '--no-network-family-autoselection --dns-result-order=ipv4first'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scope = 'User'
$separator = '-' * 78

function Merge-NodeOptions {
    param(
        [string]$Current,
        [string]$Desired
    )

    if ([string]::IsNullOrWhiteSpace($Current)) { return $Desired.Trim() }

    $existing = @($Current -split '\s+' | Where-Object { $_ -ne '' })
    $wanted = @($Desired -split '\s+' | Where-Object { $_ -ne '' })
    $merged = New-Object System.Collections.Generic.List[string]
    foreach ($item in $existing) { $merged.Add($item) }
    foreach ($item in $wanted) {
        if (-not $merged.Contains($item)) { $merged.Add($item) }
    }
    return ($merged -join ' ')
}

function Get-UserValue {
    param([string]$Name)
    return [Environment]::GetEnvironmentVariable($Name, $scope)
}

function Test-EntryPath {
    param(
        [string]$Value,
        [string]$PathType
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return (Test-Path -LiteralPath $Value -PathType $PathType)
}

# Four required path entries plus the optional NODE_OPTIONS, in the order
# ZCODE_ENV_CONTRACT declares them.
$entries = @(
    [pscustomobject]@{ Name = 'ZCODE_HOME'; Value = $ZcodeHome; PathType = 'Container'; Note = 'bootstrap root' },
    [pscustomobject]@{ Name = 'ZCODE_DATA_BASE_DIR'; Value = $ZcodeDataBaseDir; PathType = 'Container'; Note = 'parent of ZCODE_HOME' },
    [pscustomobject]@{ Name = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'; Value = $BuiltinProviderConfigFile; PathType = 'Leaf'; Note = 'built-in provider config' },
    [pscustomobject]@{ Name = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'; Value = $PersonalProviderConfigFile; PathType = 'Leaf'; Note = 'personal provider config' },
    [pscustomobject]@{ Name = 'NODE_OPTIONS'; Value = (Merge-NodeOptions -Current (Get-UserValue 'NODE_OPTIONS') -Desired $NodeOptions); PathType = ''; Note = 'optional (provider injects it at spawn); kept for interactive CLI runs' }
)

Write-Host $separator
if ($Apply) {
    Write-Host 'dsh-zcode-provider: writing ZCode environment contract (scope: User)'
} else {
    Write-Host 'dsh-zcode-provider: DRY RUN (nothing is written; pass -Apply to write)'
}
Write-Host $separator

$warnings = 0
foreach ($entry in $entries) {
    $old = Get-UserValue $entry.Name
    $new = $entry.Value

    Write-Host ('{0}' -f $entry.Name)
    Write-Host ('  scope     : {0}' -f $scope)
    Write-Host ('  current   : {0}' -f $(if ([string]::IsNullOrEmpty($old)) { '<unset>' } else { $old }))
    Write-Host ('  new value : {0}' -f $new)
    Write-Host ('  purpose   : {0}' -f $entry.Note)

    if ($entry.PathType -ne '') {
        if (Test-EntryPath -Value $new -PathType $entry.PathType) {
            Write-Host ('  path check: present ({0})' -f $entry.PathType)
        } else {
            $kind = if ($entry.PathType -eq 'Leaf') { 'file' } else { 'directory' }
            Write-Warning ('{0} does not exist as a {1}: {2}. The variable is still written; fix ZCode''s location or pass a different path with -{3}.' -f $entry.Name, $kind, $new, $entry.Name)
            $warnings = $warnings + 1
        }
    }
    Write-Host ''
}

if ($Apply) {
    foreach ($entry in $entries) {
        $old = Get-UserValue $entry.Name
        if ($entry.Name -eq 'NODE_OPTIONS' -and -not [string]::IsNullOrWhiteSpace($old)) {
            $unsafe = @($old -split '\s+' | Where-Object { $_ -match '^(--require|--import|--loader|--experimental-loader|--inspect(-brk)?|--eval|-r|-e)(=|$)' })
            if ($unsafe.Count -gt 0) {
                Write-Warning ('NODE_OPTIONS carries a loader/eval switch ({0}); the provider refuses to spawn the CLI with that value. Remove it before relying on the plugin.' -f ($unsafe -join ' '))
                $warnings = $warnings + 1
            }
        }
        if (-not $Force -and -not [string]::IsNullOrEmpty($old) -and $old -ne $entry.Value) {
            Write-Warning ('{0} already set to a different value; skipped (pass -Force to overwrite).' -f $entry.Name)
            $warnings = $warnings + 1
            continue
        }
        [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, $scope)
    }
    Write-Host $separator
    Write-Host 'Written to the user environment. DSH reads these at spawn time: restart DSH for them to take effect.'
} else {
    Write-Host $separator
    Write-Host 'Dry run only: nothing was written. Re-run with -Apply to write these values.'
}

if ($warnings -gt 0) {
    Write-Host ('{0} path warning(s): the variables are set, but the provider will still fail until the paths exist.' -f $warnings)
}

Write-Host 'Restart DSH before retrying a ZCode request (environment is read at spawn time, not per request).'
