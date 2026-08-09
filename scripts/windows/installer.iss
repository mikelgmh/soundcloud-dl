; Inno Setup script for the SoundCloud Downloader Windows installer.
;
; Compiled by scripts/build-windows-installer.ts with ISPP defines:
;   /DMyAppName, /DMyAppVersion, /DMyAppId, /DMyChannel,
;   /DSourceDir, /DOutputDir, /DOutputBaseName
;
; SourceDir points at the app bundle extracted from the electrobun tarball
; (see scripts/build-windows-installer.ts). The app bundle (bin/, Resources/,
; lib/) is installed to:
;   %LOCALAPPDATA%\{#MyAppId}\{#MyChannel}\app
; That is the exact location electrobun's Updater uses on Windows
; (Updater.runningAppBundlePath), so the app can self-update in place without
; admin rights. Do not install to Program Files, or auto-updates will break.

#ifndef MyAppName
  #define MyAppName "SoundCloud Downloader"
#endif
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyAppId
  #define MyAppId "dev.soundcloud.downloader"
#endif
#ifndef MyChannel
  #define MyChannel "stable"
#endif
#ifndef SourceDir
  #define SourceDir "build\stable-win-x64\.installer-stage\SoundCloudDownloader"
#endif
#ifndef OutputDir
  #define OutputDir "artifacts"
#endif
#ifndef OutputBaseName
  #define OutputBaseName "SoundCloudDownloader-Setup"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppName}
AppComments={#MyAppName}
DefaultDirName={localappdata}\{#MyAppId}\{#MyChannel}\app
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
CloseApplicationFilter=launcher.exe,bun.exe,bun Helper.exe,process_helper.exe
RestartApplications=no
SetupLogging=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\bin\launcher.exe
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppName}
VersionInfoDescription={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\bin\launcher.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\launcher.exe"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\{#MyAppId}\{#MyChannel}\self-extraction"
