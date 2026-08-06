$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class SupplyFlowJobRunResult
{
    public string Status;
    public long? ExitCode;
    public string Cleanup;
    public string Reason;
}

public static class SupplyFlowWindowsJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint STD_OUTPUT_HANDLE = unchecked((uint)-11);
    private const uint STD_ERROR_HANDLE = unchecked((uint)-12);
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int infoType,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int infoType,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength,
        IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr hSourceProcessHandle,
        IntPtr hSourceHandle,
        IntPtr hTargetProcessHandle,
        out IntPtr lpTargetHandle,
        uint dwDesiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
        uint dwOptions);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint nStdHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static IntPtr DuplicateInheritedStandardHandle(uint standardHandle)
    {
        IntPtr source = GetStdHandle(standardHandle);
        if (source == IntPtr.Zero || source == INVALID_HANDLE_VALUE)
        {
            throw LastError("GetStdHandle");
        }
        IntPtr duplicate;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, source, current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
        {
            throw LastError("DuplicateHandle");
        }
        return duplicate;
    }

    private static IntPtr OpenInheritedNullInput()
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        IntPtr handle = CreateFile(
            "NUL",
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ref attributes,
            OPEN_EXISTING,
            0,
            IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw LastError("CreateFile(NUL)");
        return handle;
    }

    private static string QuoteArgument(string value)
    {
        if (value == null) throw new ArgumentNullException("value");
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static StringBuilder CommandLine(string executable, string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static IntPtr EnvironmentBlock(IDictionary<string, string> environment)
    {
        List<KeyValuePair<string, string>> values = new List<KeyValuePair<string, string>>(environment);
        values.Sort(delegate(KeyValuePair<string, string> left, KeyValuePair<string, string> right)
        {
            return StringComparer.OrdinalIgnoreCase.Compare(left.Key, right.Key);
        });
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> value in values)
        {
            if (String.IsNullOrEmpty(value.Key) || value.Key.IndexOf('\0') >= 0 || value.Key.IndexOf('=', 1) >= 0)
            {
                throw new ArgumentException("The child environment contains an invalid variable name.");
            }
            if (value.Value == null || value.Value.IndexOf('\0') >= 0)
            {
                throw new ArgumentException("The child environment contains an invalid variable value.");
            }
            block.Append(value.Key);
            block.Append('=');
            block.Append(value.Value);
            block.Append('\0');
        }
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void EnableKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                throw LastError("SetInformationJobObject");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            out information,
            size,
            IntPtr.Zero))
        {
            throw LastError("QueryInformationJobObject");
        }
        return information.ActiveProcesses;
    }

    private static bool WaitUntilEmpty(IntPtr job, int timeoutMs)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        do
        {
            if (ActiveProcesses(job) == 0) return true;
            Thread.Sleep(25);
        }
        while (elapsed.ElapsedMilliseconds < timeoutMs);
        return ActiveProcesses(job) == 0;
    }

    private static string HoldUntilJobEmpty(IntPtr job, string reason)
    {
        Stopwatch notice = Stopwatch.StartNew();
        long nextNoticeMs = 0;
        // Deliberately unbounded: returning without ACTIVE_PROCESS_ZERO would release the QA mutex unsafely.
        for (;;)
        {
            try
            {
                if (ActiveProcesses(job) == 0) return "JOB_EMPTY";
            }
            catch
            {
                // Query failure is not proof of cleanup. Keep the Job handle and mutex alive.
            }
            if (notice.ElapsedMilliseconds >= nextNoticeMs)
            {
                Console.Error.WriteLine(
                    "[QA BLOCKED] " + reason
                    + " The shared QA mutex remains held until ACTIVE_PROCESS_ZERO can be proven.");
                nextNoticeMs = notice.ElapsedMilliseconds + 30000;
            }
            Thread.Sleep(1000);
        }
    }

    private static string TerminateAndDrainOrHold(IntPtr job, int cleanupTimeoutMs, string reason)
    {
        bool terminationRequested = TerminateJobObject(job, 124);
        if (!terminationRequested)
        {
            try
            {
                if (ActiveProcesses(job) == 0) return "JOB_EMPTY";
            }
            catch
            {
                // Fall through to the containment hold below.
            }
            return HoldUntilJobEmpty(job, reason + " TerminateJobObject failed.");
        }
        try
        {
            if (WaitUntilEmpty(job, cleanupTimeoutMs)) return "JOB_EMPTY";
        }
        catch
        {
            // Fall through to the containment hold below.
        }
        return HoldUntilJobEmpty(job, reason + " The cleanup deadline expired.");
    }

    private static void HoldUntilProcessExit(IntPtr process, string reason)
    {
        Stopwatch notice = Stopwatch.StartNew();
        long nextNoticeMs = 0;
        // The suspended process cannot run, but its exit must still be proven before the mutex can be released.
        for (;;)
        {
            if (WaitForSingleObject(process, 1000) == WAIT_OBJECT_0) return;
            if (notice.ElapsedMilliseconds >= nextNoticeMs)
            {
                Console.Error.WriteLine(
                    "[QA BLOCKED] " + reason
                    + " The shared QA mutex remains held until the suspended process exit is proven.");
                nextNoticeMs = notice.ElapsedMilliseconds + 30000;
            }
        }
    }

    private static void TerminateUnassignedProcessOrHold(IntPtr process, int cleanupTimeoutMs)
    {
        bool terminationRequested = TerminateProcess(process, 125);
        uint wait = WaitForSingleObject(process, (uint)cleanupTimeoutMs);
        if (wait == WAIT_OBJECT_0) return;
        string reason = terminationRequested
            ? "The unassigned suspended process exceeded its cleanup deadline."
            : "TerminateProcess failed for an unassigned suspended process.";
        HoldUntilProcessExit(process, reason);
    }

    private static SupplyFlowJobRunResult Blocked(string reason)
    {
        return new SupplyFlowJobRunResult
        {
            Status = "BLOCKED",
            ExitCode = null,
            Cleanup = "JOB_EMPTY",
            Reason = reason
        };
    }

    public static SupplyFlowJobRunResult Run(
        string executable,
        string[] arguments,
        string cwd,
        IDictionary<string, string> environment,
        int parentPid,
        int timeoutMs,
        int descendantGraceMs,
        int cleanupTimeoutMs)
    {
        if (String.IsNullOrWhiteSpace(executable)) throw new ArgumentException("Executable is required.");
        if (String.IsNullOrWhiteSpace(cwd)) throw new ArgumentException("Working directory is required.");
        if (arguments == null) throw new ArgumentNullException("arguments");
        if (environment == null) throw new ArgumentNullException("environment");
        if (parentPid <= 0 || timeoutMs <= 0 || descendantGraceMs <= 0 || cleanupTimeoutMs <= 0)
        {
            throw new ArgumentException("Process identifiers and timeouts must be positive.");
        }

        IntPtr parent = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr standardInput = IntPtr.Zero;
        IntPtr standardOutput = IntPtr.Zero;
        IntPtr standardError = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        bool processAssigned = false;

        try
        {
            parent = OpenProcess(SYNCHRONIZE, false, (uint)parentPid);
            if (parent == IntPtr.Zero) throw LastError("OpenProcess(parent)");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject");
            EnableKillOnClose(job);

            standardInput = OpenInheritedNullInput();
            standardOutput = DuplicateInheritedStandardHandle(STD_OUTPUT_HANDLE);
            standardError = DuplicateInheritedStandardHandle(STD_ERROR_HANDLE);
            environmentBlock = EnvironmentBlock(environment);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = standardInput;
            startup.hStdOutput = standardOutput;
            startup.hStdError = standardError;

            if (!CreateProcess(
                executable,
                CommandLine(executable, arguments),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environmentBlock,
                cwd,
                ref startup,
                out process))
            {
                throw LastError("CreateProcess");
            }
            processCreated = true;

            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                throw LastError("AssignProcessToJobObject");
            }
            processAssigned = true;

            if (ResumeThread(process.hThread) == INFINITE)
            {
                throw LastError("ResumeThread");
            }
            Stopwatch elapsed = Stopwatch.StartNew();
            long? primaryExitedAtMs = null;
            uint primaryExitCode = 0;

            for (;;)
            {
                if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0)
                {
                    TerminateAndDrainOrHold(
                        job,
                        cleanupTimeoutMs,
                        "The QA parent process exited before the Windows Job completed.");
                    return Blocked("The QA parent process exited before the Windows Job completed.");
                }

                uint primaryWait = WaitForSingleObject(process.hProcess, 0);
                if (primaryWait == WAIT_OBJECT_0 && !primaryExitedAtMs.HasValue)
                {
                    if (!GetExitCodeProcess(process.hProcess, out primaryExitCode))
                    {
                        TerminateAndDrainOrHold(job, cleanupTimeoutMs, "The primary process exit code could not be read.");
                        return Blocked("The primary process exit code could not be read.");
                    }
                    primaryExitedAtMs = elapsed.ElapsedMilliseconds;
                }
                else if (primaryWait != WAIT_OBJECT_0 && primaryWait != WAIT_TIMEOUT)
                {
                    TerminateAndDrainOrHold(job, cleanupTimeoutMs, "The primary process state could not be read.");
                    return Blocked("The primary process state could not be read.");
                }

                uint active;
                try
                {
                    active = ActiveProcesses(job);
                }
                catch
                {
                    TerminateAndDrainOrHold(
                        job,
                        cleanupTimeoutMs,
                        "The Windows Job active-process count could not be verified.");
                    return Blocked("The Windows Job active-process count could not be verified.");
                }

                if (primaryExitedAtMs.HasValue && active == 0)
                {
                    return new SupplyFlowJobRunResult
                    {
                        Status = "EXITED",
                        ExitCode = (long)primaryExitCode,
                        Cleanup = "JOB_EMPTY",
                        Reason = null
                    };
                }

                long nowMs = elapsed.ElapsedMilliseconds;
                if (nowMs >= timeoutMs)
                {
                    TerminateAndDrainOrHold(job, cleanupTimeoutMs, "The Windows Job command timed out.");
                    return new SupplyFlowJobRunResult
                    {
                        Status = "TIMED_OUT",
                        ExitCode = null,
                        Cleanup = "JOB_EMPTY",
                        Reason = null
                    };
                }
                if (primaryExitedAtMs.HasValue && nowMs - primaryExitedAtMs.Value >= descendantGraceMs)
                {
                    TerminateAndDrainOrHold(
                        job,
                        cleanupTimeoutMs,
                        "Descendant processes remained after the primary process exited.");
                    return Blocked("Descendant processes remained after the primary process exited and were terminated.");
                }
                Thread.Sleep(25);
            }
        }
        catch (Exception error)
        {
            if (processCreated && !processAssigned)
            {
                TerminateUnassignedProcessOrHold(process.hProcess, cleanupTimeoutMs);
            }
            if (job != IntPtr.Zero)
            {
                TerminateAndDrainOrHold(job, cleanupTimeoutMs, "Windows Job setup or execution failed.");
            }
            return Blocked(error.Message);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (standardInput != IntPtr.Zero && standardInput != INVALID_HANDLE_VALUE) CloseHandle(standardInput);
            if (standardOutput != IntPtr.Zero && standardOutput != INVALID_HANDLE_VALUE) CloseHandle(standardOutput);
            if (standardError != IntPtr.Zero && standardError != INVALID_HANDLE_VALUE) CloseHandle(standardError);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != IntPtr.Zero) CloseHandle(parent);
        }
    }
}
'@

function Write-JobResult {
    param(
        [Parameter(Mandatory = $true)] [object] $Specification,
        [Parameter(Mandatory = $true)] [object] $NativeResult
    )
    $payload = [ordered]@{
        schemaVersion = 1
        token = [string] $Specification.token
        status = [string] $NativeResult.Status
        exitCode = $NativeResult.ExitCode
        cleanup = [string] $NativeResult.Cleanup
    }
    # The TypeScript protocol requires reason to be a string or absent; a JSON
    # null fails validation and turns a valid TIMED_OUT into a containment hold.
    if ($null -ne $NativeResult.Reason) {
        $payload.reason = [string] $NativeResult.Reason
    }
    $resultPath = [string] $Specification.resultPath
    $temporaryPath = "$resultPath.$PID.tmp"
    $json = $payload | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporaryPath, $resultPath)
}

$specification = $null
$nativeInvocationStarted = $false
try {
    # [Console]::In decodes with the OEM codepage; the parent writes UTF-8, so
    # non-ASCII environment values (Hebrew paths) arrive mangled. Read the raw
    # stdin stream as UTF-8 explicitly.
    $stdinReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
    $rawSpecification = $stdinReader.ReadToEnd()
    $specification = $rawSpecification | ConvertFrom-Json
    if ($specification.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string] $specification.token)) {
        throw 'The Windows Job specification is invalid.'
    }

    $null = Add-Type -TypeDefinition $nativeSource -Language CSharp
    $environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $specification.environment.PSObject.Properties) {
        $environment[[string] $property.Name] = [string] $property.Value
    }
    [string[]] $arguments = @($specification.args | ForEach-Object { [string] $_ })
    $nativeInvocationStarted = $true
    $nativeResult = [SupplyFlowWindowsJob]::Run(
        [string] $specification.executable,
        $arguments,
        [string] $specification.cwd,
        $environment,
        [Convert]::ToInt32($specification.parentPid),
        [Convert]::ToInt32($specification.timeoutMs),
        [Convert]::ToInt32($specification.descendantGraceMs),
        [Convert]::ToInt32($specification.cleanupTimeoutMs)
    )
    Write-JobResult -Specification $specification -NativeResult $nativeResult
    exit 0
}
catch {
    $canProveNoNativeChild = -not $nativeInvocationStarted -and $null -ne $specification
    if ($canProveNoNativeChild -and -not [string]::IsNullOrWhiteSpace([string] $specification.resultPath)) {
        try {
            $blocked = [PSCustomObject]@{
                Status = 'BLOCKED'
                ExitCode = $null
                Cleanup = 'JOB_EMPTY'
                Reason = $_.Exception.Message
            }
            Write-JobResult -Specification $specification -NativeResult $blocked
        }
        catch {
            # The TypeScript parent treats a missing protocol result as BLOCKED.
        }
    }
    exit 2
}
