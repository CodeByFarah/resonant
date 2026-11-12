; Windows installer for Resonant, built with Inno Setup 6 from the app electron-builder packages
; into dist\win-unpacked. Run through `npm run dist:win`, which passes the version:
;   iscc /DAppVersion=1.0.0 installer.iss
; Installs for the current user (no administrator prompt) unless they choose all users.
; Uninstalling leaves the user's data (%APPDATA%\Resonant) in place.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F3C2A9E-4B1D-4E7A-9C52-8D1E0F7A3B64}
AppName=Resonant
AppVersion={#AppVersion}
AppVerName=Resonant {#AppVersion}
AppPublisher=Resonant
AppComments=A voice studio that runs on your own computer.
DefaultDirName={autopf}\Resonant
DefaultGroupName=Resonant
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=dist
OutputBaseFilename=Resonant-Setup-{#AppVersion}
SetupIconFile=build\icon.ico
UninstallDisplayIcon={app}\Resonant.exe
UninstallDisplayName=Resonant
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Resonant"; Filename: "{app}\Resonant.exe"
Name: "{autodesktop}\Resonant"; Filename: "{app}\Resonant.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Resonant.exe"; Description: "{cm:LaunchProgram,Resonant}"; Flags: nowait postinstall skipifsilent
