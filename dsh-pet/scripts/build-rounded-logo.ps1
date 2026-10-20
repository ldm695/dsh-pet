$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'assets\logo.png'
$outputPath = Join-Path $projectRoot 'assets\logo-rounded.png'
$source = [System.Drawing.Bitmap]::new($sourcePath)
$bitmap = $null
$graphics = $null

try {
  if ($source.Width -ne $source.Height) {
    throw "Expected a square upstream logo, got $($source.Width)×$($source.Height)."
  }

  $bitmap = [System.Drawing.Bitmap]::new(
    $source.Width,
    $source.Height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.DrawImage($source, 0, 0, $source.Width, $source.Height)
  $graphics.Dispose()
  $graphics = $null

  $radius = [Math]::Round($source.Width * 0.18)
  $edgeSoftness = 1.0
  for ($y = 0; $y -lt $bitmap.Height; $y++) {
    for ($x = 0; $x -lt $bitmap.Width; $x++) {
      $centerX = if ($x -lt $radius) {
        $radius
      } elseif ($x -ge $bitmap.Width - $radius) {
        $bitmap.Width - $radius - 1
      } else {
        $x
      }
      $centerY = if ($y -lt $radius) {
        $radius
      } elseif ($y -ge $bitmap.Height - $radius) {
        $bitmap.Height - $radius - 1
      } else {
        $y
      }

      if ($centerX -ne $x -or $centerY -ne $y) {
        $distance = [Math]::Sqrt(
          [Math]::Pow($x + 0.5 - $centerX, 2) + [Math]::Pow($y + 0.5 - $centerY, 2)
        )
        $signedDistance = $radius - $distance
        $transition = [Math]::Max(
          [double]0,
          [Math]::Min([double]1, ($signedDistance + $edgeSoftness) / (2 * $edgeSoftness))
        )
        $coverage = $transition * $transition * (3 - 2 * $transition)
        if ($coverage -lt 1) {
          $color = $bitmap.GetPixel($x, $y)
          $alpha = [int][Math]::Round($color.A * $coverage)
          $bitmap.SetPixel(
            $x,
            $y,
            [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
          )
        }
      }
    }
  }

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "Generated rounded logo: $outputPath ($($bitmap.Width)×$($bitmap.Height), radius ${radius}px)"
} finally {
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
  $source.Dispose()
}
