Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile("$PSScriptRoot\logo.png")
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = "HighQualityBicubic"
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, 0, 0, 256, 256)
$src.Dispose()
$bmp.Save("$PSScriptRoot\icon.png")
$g.Dispose()
$bmp.Dispose()
"Wrote $PSScriptRoot\icon.png"
