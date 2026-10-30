# Windows research sandbox launcher (called by server/core/research-python.mjs).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files in the
# system code page.
#
# Python runs inside an AppContainer with no capabilities: no internetClient,
# so no network and no loopback; it can only touch directories explicitly
# granted to the AppContainer SID, the rest of the user profile is invisible.
# A Job object adds: one active process (no child processes), a hard memory
# cap, and KILL_ON_JOB_CLOSE so Python dies with this launcher.
# Any failure aborts; there is no fallback to an unconfined run.
param(
  [Parameter(Mandatory = $true)][string]$Python,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$ReadDirs,   # "|"-separated directories that need read+execute
  [Parameter(Mandatory = $true)][string]$ArgumentsBase64,  # UTF-8 python.exe arguments, already quoted for Windows
  [int]$MemoryMb = 2048,
  [string]$ContainerName = "open-medical.research-sandbox"
)
$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OmAppContainer {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
  const uint LIMIT_ACTIVE_PROCESS = 0x8, LIMIT_PROCESS_MEMORY = 0x100, LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  static IntPtr Sid(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "Open Medical research sandbox", IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (hr != 0) throw new Win32Exception(hr, "AppContainer profile failed: 0x" + hr.ToString("X8"));
    return sid;
  }

  public static string SidString(string name) {
    IntPtr text;
    if (!ConvertSidToStringSidW(Sid(name), out text)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
  }

  public static int Run(string name, string python, string commandLine, string cwd, string environment, long memoryBytes) {
    IntPtr sid = Sid(name);
    SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
    IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(caps));
    Marshal.StructureToPtr(caps, capsPtr, false);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capsPtr, (IntPtr)Marshal.SizeOf(caps), IntPtr.Zero, IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error());

    STARTUPINFOEX si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(si);
    si.lpAttributeList = list;
    si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.StartupInfo.hStdInput = IntPtr.Zero;
    si.StartupInfo.hStdOutput = GetStdHandle(-11);
    si.StartupInfo.hStdError = GetStdHandle(-12);
    SetHandleInformation(si.StartupInfo.hStdOutput, 1, 1);
    SetHandleInformation(si.StartupInfo.hStdError, 1, 1);

    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = LIMIT_ACTIVE_PROCESS | LIMIT_PROCESS_MEMORY | LIMIT_DIE_ON_UNHANDLED_EXCEPTION | LIMIT_KILL_ON_JOB_CLOSE;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.ProcessMemoryLimit = (UIntPtr)(ulong)memoryBytes;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception(Marshal.GetLastWin32Error());

    IntPtr env = Marshal.StringToHGlobalUni(environment);
    PROCESS_INFORMATION pi;
    var cmd = new System.Text.StringBuilder(commandLine);
    bool ok = CreateProcessW(python, cmd, IntPtr.Zero, IntPtr.Zero, true,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env, cwd, ref si, out pi);
    int error = Marshal.GetLastWin32Error();
    DeleteProcThreadAttributeList(list);
    Marshal.FreeHGlobal(list);
    Marshal.FreeHGlobal(capsPtr);
    Marshal.FreeHGlobal(env);
    if (!ok) throw new Win32Exception(error, "CreateProcess in AppContainer failed: error " + error + " (" + new Win32Exception(error).Message + ")");
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      int assignError = Marshal.GetLastWin32Error();
      TerminateProcess(pi.hProcess, 1);
      throw new Win32Exception(assignError, "AssignProcessToJobObject failed: error " + assignError + " (" + new Win32Exception(assignError).Message + ")");
    }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(job);
    return (int)code;
  }
}
"@

if (-not ("OmAppContainer" -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }

$sid = [OmAppContainer]::SidString($ContainerName)

# Grant inheritable read+execute on each top directory once; skip when the
# SID (or ALL APPLICATION PACKAGES, S-1-15-2-1, e.g. Program Files) already
# has access, so we do not rewrite large ACL trees on every run.
foreach ($dir in ($ReadDirs -split "\|" | Where-Object { $_ })) {
  $rules = [System.IO.Directory]::GetAccessControl($dir).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  $granted = $rules | Where-Object { $_.AccessControlType -eq "Allow" -and ($_.IdentityReference.Value -eq $sid -or $_.IdentityReference.Value -eq "S-1-15-2-1") }
  if (-not $granted) {
    & "$env:SystemRoot\System32\icacls.exe" $dir /grant "*${sid}:(OI)(CI)RX" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot grant sandbox read access: $dir" }
  }
}
& "$env:SystemRoot\System32\icacls.exe" $WorkDir /grant "*${sid}:(OI)(CI)M" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Cannot grant sandbox work directory: $WorkDir" }

# Minimal environment for the child; no secrets.
$envBlock = "SystemRoot=$env:SystemRoot`0TEMP=$WorkDir`0TMP=$WorkDir`0USERPROFILE=$WorkDir`0HOME=$WorkDir`0MPLCONFIGDIR=$WorkDir`0PYTHONIOENCODING=utf-8`0PYTHONUTF8=1`0OPENBLAS_NUM_THREADS=1`0OMP_NUM_THREADS=1`0MKL_NUM_THREADS=1`0`0"
$arguments = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ArgumentsBase64))
$commandLine = '"' + $Python + '" ' + $arguments
$code = [OmAppContainer]::Run($ContainerName, $Python, $commandLine, $WorkDir, $envBlock, [long]$MemoryMb * 1MB)
exit $code
