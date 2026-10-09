# =====================================================================
# レッドストーン拡張アドオン デプロイスクリプト
#
# ソースの RedstoneExtBP / RedstoneExtRP を com.mojang へミラーコピーする。
#
# 重要: コピー先は**フォルダ名ではなく manifest の UUID で探す**。
#   .mcaddon をダブルクリックしてインポートすると、manifest の name が
#   翻訳キー(pack.name)のままなので `pack(23)` のような名前のフォルダに入る。
#   フォルダ名決め打ちでコピーすると、ワールドが読んでいるのはインポート版のまま、
#   こちらの修正はどこにも反映されない、という状態になる（実際に起きた）。
#   UUID が一致するフォルダすべてに配り、見つからなければ既定の名前で新規作成する。
#
# 使い方(PowerShellで):
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1
# ※ Minecraft を完全終了してから実行すること(ファイルロック回避)
# =====================================================================

$root = Split-Path $PSScriptRoot -Parent            # リポジトリの根
$mojShared = "$env:APPDATA\Minecraft Bedrock\Users\Shared\games\com.mojang"

$BP_UUID = "175b00db-fa24-4873-b3e6-3f2d29b6c1f5"
$RP_UUID = "f8d7d70b-3cc8-42c6-89ef-eaffa867ed2a"

if (-not (Test-Path $mojShared)) {
  Write-Host "com.mojang が見つかりません: $mojShared"
  Write-Host "ランチャー版以外を使っている場合は、このパスを環境に合わせて書き換えてください。"
  exit 1
}

$proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "inecraft" }
if ($proc) {
  Write-Host "Minecraft が起動中です。完全に終了してから実行してください。"
  exit 1
}

# UUID が一致するインストール済みフォルダを列挙する
function Find-InstalledPacks($parent, $uuid) {
  if (-not (Test-Path $parent)) { return @() }
  $hits = @()
  Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $manifest = Join-Path $_.FullName "manifest.json"
    if (Test-Path $manifest) {
      $text = Get-Content $manifest -Raw -ErrorAction SilentlyContinue
      if ($text -match $uuid) { $hits += $_.FullName }
    }
  }
  return $hits
}

function Deploy-Pack($src, $parent, $uuid, $defaultName) {
  $targets = Find-InstalledPacks $parent $uuid
  if ($targets.Count -eq 0) {
    $targets = @(Join-Path $parent $defaultName)
    Write-Host "  インストール済みが無いので新規作成: $($targets[0])"
  }
  $ok = $true
  foreach ($dst in $targets) {
    # generate_wire_permutations.js はビルド専用なので配布物には入れない
    robocopy $src $dst /MIR /XF generate_wire_permutations.js /NFL /NDL /NJH /NJS /NP > $null
    if ($LASTEXITCODE -ge 8) {
      Write-Host "  robocopy エラー ($LASTEXITCODE): $dst"
      $ok = $false
    } else {
      Write-Host "  -> $dst"
    }
  }
  return $ok
}

Write-Host "ビヘイビアパック:"
$bpOk = Deploy-Pack (Join-Path $root "RedstoneExtBP") (Join-Path $mojShared "behavior_packs") $BP_UUID "RedstoneExtBP"
Write-Host "リソースパック:"
$rpOk = Deploy-Pack (Join-Path $root "RedstoneExtRP") (Join-Path $mojShared "resource_packs") $RP_UUID "RedstoneExtRP"

if ($bpOk -and $rpOk) {
  Write-Host ""
  Write-Host "デプロイ完了。Minecraft を起動してワールドを開き直してください。"
  exit 0
} else {
  exit 1
}
