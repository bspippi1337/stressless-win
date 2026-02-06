#define AppName "Stressless"
#define AppVersion "0.1.0-alpha"
#define AppPublisher "bspippi1337"
#define AppURL "https://github.com/bspippi1337/Stressless-win"
#define AppExeName "Stressless.Wpf.exe"

[Setup]
SetupIconFile=..\branding\stressless.ico
UninstallDisplayIcon={app}\Stressless.Wpf.exe
AppId={{C5C7E5C3-2CC7-4F52-9A5A-9B8A8B74C2C1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist\windows
OutputBaseFilename=StresslessSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "dist\portable\Stressless\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
