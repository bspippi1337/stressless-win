# Windows Code Signing (Free / Practical)

Stressless uses **self-signed code signing** during early alpha.
This enables signed binaries without cost and is suitable for:
- internal distribution
- investor demos
- technical early adopters

> SmartScreen reputation requires a paid EV certificate and is intentionally deferred.

---

## 1. Create a code-signing certificate (one time)

Run PowerShell **as Administrator**:

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Stressless Software" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 4096 `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(3)

$pwd = ConvertTo-SecureString -String "stressless" -Force -AsPlainText

Export-PfxCertificate `
  -Cert $cert `
  -FilePath ".\stressless_codesign.pfx" `
  -Password $pwd
```

⚠️ Do **not** commit `stressless_codesign.pfx`.

---

## 2. Trust the certificate locally (for testing)

```powershell
Import-PfxCertificate `
  -FilePath .\stressless_codesign.pfx `
  -CertStoreLocation Cert:\CurrentUser\TrustedPublisher `
  -Password (ConvertTo-SecureString "stressless" -AsPlainText -Force)
```

---

## 3. Sign binaries

Portable app:
```powershell
signtool sign /fd SHA256 /f stressless_codesign.pfx /p stressless dist\portable\stressless\Stressless.Wpf.exe
```

Installer:
```powershell
signtool sign /fd SHA256 /f stressless_codesign.pfx /p stressless dist\windows\StresslessSetup.exe
```

Verify:
```powershell
signtool verify /pa Stressless.Wpf.exe
```

---

## 4. Automatic signing (recommended)

If `stressless_codesign.pfx` exists in repo root, build scripts will sign automatically.

---

## Notes

- This is normal for early-stage Windows software.
- Paid EV signing can be added later without architectural changes.

© Stressless
