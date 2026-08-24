using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace HurogiCollector;

internal static class ManagedInstallLaunchBridge
{
    private const long MaximumPointerBytes = 64 * 1024;
    private const long MaximumManifestBytes = 4 * 1024 * 1024;

    internal static bool ContinueCurrentProcessOrRelaunch() =>
        ContinueCurrentProcessOrRelaunch(out _);

    internal static bool ContinueCurrentProcessOrRelaunch(out bool isCurrentManagedProcess)
    {
        isCurrentManagedProcess = false;
        var context = TryGetManagedContext();
        if (context is null) return true;

        using var pointer = ReadSmallJson(context.PointerPath, MaximumPointerBytes);
        var currentVersion = RequiredString(pointer.RootElement, "version");
        if (!IsFourPartVersion(currentVersion))
            throw new InvalidDataException("별록 설치 버전 정보가 손상되었습니다.");

        var currentExecutable = VerifyVersionExecutable(context.InstallRoot, currentVersion);
        if (PathsEqual(currentExecutable, context.RunningExecutable))
        {
            isCurrentManagedProcess = true;
            return true;
        }

        _ = Process.Start(new ProcessStartInfo
        {
            FileName = currentExecutable,
            WorkingDirectory = Path.GetDirectoryName(currentExecutable)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        }) ?? throw new InvalidOperationException("현재 별록 버전을 시작하지 못했습니다.");
        return false;
    }

    internal static bool StartCurrentAfterProcessExit(int processId)
    {
        if (processId <= 0) throw new ArgumentOutOfRangeException(nameof(processId));
        var context = TryGetManagedContext();
        if (context is null) return false;

        using var pointer = ReadSmallJson(context.PointerPath, MaximumPointerBytes);
        var currentVersion = RequiredString(pointer.RootElement, "version");
        var currentExecutable = VerifyVersionExecutable(context.InstallRoot, currentVersion);
        if (PathsEqual(currentExecutable, context.RunningExecutable)) return false;

        var start = new ProcessStartInfo
        {
            FileName = currentExecutable,
            WorkingDirectory = Path.GetDirectoryName(currentExecutable)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.ArgumentList.Add("--continue-after-update");
        start.ArgumentList.Add(processId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        _ = Process.Start(start) ?? throw new InvalidOperationException("업데이트된 별록을 시작하지 못했습니다.");
        return true;
    }

    internal static void RepairCurrentShortcuts(Action<string>? log = null)
    {
        try
        {
            var context = TryGetManagedContext();
            if (context is null) return;

            using var pointer = ReadSmallJson(context.PointerPath, MaximumPointerBytes);
            var currentVersion = RequiredString(pointer.RootElement, "version");
            var currentExecutable = VerifyVersionExecutable(context.InstallRoot, currentVersion);
            if (!PathsEqual(currentExecutable, context.RunningExecutable)) return;

            var startMenuPrograms = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                "Programs");
            Directory.CreateDirectory(startMenuPrograms);
            var startMenuShortcut = ChooseManagedShortcutPath(
                Path.Combine(startMenuPrograms, "별록.lnk"),
                Path.Combine(startMenuPrograms, "별록 최신.lnk"),
                context.InstallRoot);
            if (startMenuShortcut is not null)
                SaveShortcut(startMenuShortcut, currentExecutable, Path.GetDirectoryName(currentExecutable)!);
            RepairExistingManagedShortcut(
                Path.Combine(startMenuPrograms, "별록.lnk"),
                context.InstallRoot,
                currentExecutable);
            RepairExistingManagedShortcut(
                Path.Combine(startMenuPrograms, "별록 최신.lnk"),
                context.InstallRoot,
                currentExecutable);
            RepairExistingManagedShortcut(
                Path.Combine(startMenuPrograms, "별록 에이전트.lnk"),
                context.InstallRoot,
                currentExecutable);

            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var desktopShortcut = Path.Combine(desktop, "별록.lnk");
            var desktopAlternate = Path.Combine(desktop, "별록 최신.lnk");
            var legacyNamedDesktopShortcut = Path.Combine(desktop, "별록 에이전트.lnk");
            if (File.Exists(legacyNamedDesktopShortcut)
                || File.Exists(desktopShortcut)
                || File.Exists(desktopAlternate))
            {
                var safeDesktopShortcut = ChooseManagedShortcutPath(
                    desktopShortcut,
                    desktopAlternate,
                    context.InstallRoot);
                if (safeDesktopShortcut is not null)
                    SaveShortcut(safeDesktopShortcut, currentExecutable, Path.GetDirectoryName(currentExecutable)!);
            }
            RepairExistingManagedShortcut(desktopShortcut, context.InstallRoot, currentExecutable);
            RepairExistingManagedShortcut(desktopAlternate, context.InstallRoot, currentExecutable);
            RepairExistingManagedShortcut(legacyNamedDesktopShortcut, context.InstallRoot, currentExecutable);

        }
        catch (Exception ex)
        {
            log?.Invoke("관리형 바로가기 정리 보류: " + ex.GetType().Name);
        }
    }

    private static ManagedContext? TryGetManagedContext()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var installRoot = Path.GetFullPath(Path.Combine(localAppData, "Programs", "ByeollogCollector"));
        var versionsRoot = Path.GetFullPath(Path.Combine(installRoot, "versions"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var running = Path.GetFullPath(Environment.ProcessPath ?? Application.ExecutablePath);
        if (!running.StartsWith(versionsRoot, StringComparison.OrdinalIgnoreCase)) return null;
        return new ManagedContext(installRoot, running, Path.Combine(installRoot, "current.json"));
    }

    private static string VerifyVersionExecutable(string installRoot, string version)
    {
        if (!IsFourPartVersion(version))
            throw new InvalidDataException("별록 설치 버전 정보가 올바르지 않습니다.");

        var versionsRoot = Path.GetFullPath(Path.Combine(installRoot, "versions"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var versionRoot = Path.GetFullPath(Path.Combine(versionsRoot, version));
        if (!versionRoot.StartsWith(versionsRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("별록 설치 경로가 안전하지 않습니다.");

        var manifestPath = Path.Combine(versionRoot, "release-manifest.json");
        using var manifest = ReadSmallJson(manifestPath, MaximumManifestBytes);
        var root = manifest.RootElement;
        if (RequiredString(root, "product") != "byeollog-collector"
            || RequiredString(root, "version") != version)
            throw new InvalidDataException("별록 설치 정보가 현재 버전과 일치하지 않습니다.");

        var schema = root.GetProperty("schemaVersion").GetInt32();
        JsonElement? executableEntry = null;
        foreach (var entry in root.GetProperty("files").EnumerateArray())
        {
            if (!string.Equals(RequiredString(entry, "path"), "byeollog.exe", StringComparison.Ordinal))
                continue;
            if (schema == 2 && !string.Equals(RequiredString(entry, "role"), "app", StringComparison.Ordinal))
                continue;
            executableEntry = entry.Clone();
            break;
        }
        if (executableEntry is null)
            throw new InvalidDataException("별록 실행 파일 정보가 없습니다.");

        var executable = Path.Combine(versionRoot, "byeollog.exe");
        var item = new FileInfo(executable);
        if (!item.Exists || item.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("별록 실행 파일이 없거나 안전하지 않습니다.");
        var expectedBytes = executableEntry.Value.GetProperty("byteSize").GetInt64();
        var expectedHash = RequiredString(executableEntry.Value, "sha256").ToLowerInvariant();
        if (item.Length != expectedBytes || expectedHash.Length != 64)
            throw new InvalidDataException("별록 실행 파일 크기 정보가 일치하지 않습니다.");
        using var stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
        var actualHash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(expectedHash),
                Convert.FromHexString(actualHash)))
            throw new InvalidDataException("별록 실행 파일 무결성 확인에 실패했습니다.");
        return executable;
    }

    private static JsonDocument ReadSmallJson(string path, long maximumBytes)
    {
        var item = new FileInfo(path);
        if (!item.Exists || item.Length <= 0 || item.Length > maximumBytes
            || item.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("별록 설치 정보 파일이 없거나 안전하지 않습니다.");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static string RequiredString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("별록 설치 정보 필드가 없습니다: " + name);
        return value.GetString() ?? "";
    }

    private static bool IsFourPartVersion(string value)
    {
        var parts = value.Split('.');
        return parts.Length == 4 && parts.All(part => int.TryParse(part, out var number) && number >= 0);
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

    private static void SaveShortcut(string shortcutPath, string target, string workingDirectory)
    {
        object? shell = null;
        object? shortcut = null;
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell")
                ?? throw new InvalidOperationException("Windows 바로가기 서비스를 찾지 못했습니다.");
            shell = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("Windows 바로가기 서비스를 시작하지 못했습니다.");
            shortcut = shellType.InvokeMember(
                "CreateShortcut",
                System.Reflection.BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath });
            var type = shortcut!.GetType();
            type.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { target });
            type.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "" });
            type.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
            type.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
            type.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "별록 에이전트" });
            type.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private static string? ChooseManagedShortcutPath(string preferred, string alternate, string installRoot)
    {
        if (!File.Exists(preferred) || ShortcutBelongsToInstall(preferred, installRoot))
            return preferred;
        if (!File.Exists(alternate) || ShortcutBelongsToInstall(alternate, installRoot))
            return alternate;
        return null;
    }

    private static void RepairExistingManagedShortcut(
        string shortcutPath,
        string installRoot,
        string currentExecutable)
    {
        if (!File.Exists(shortcutPath) || !ShortcutBelongsToInstall(shortcutPath, installRoot)) return;
        SaveShortcut(shortcutPath, currentExecutable, Path.GetDirectoryName(currentExecutable)!);
    }

    private static bool ShortcutBelongsToInstall(string shortcutPath, string installRoot)
    {
        object? shell = null;
        object? shortcut = null;
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null) return false;
            shell = Activator.CreateInstance(shellType);
            if (shell is null) return false;
            shortcut = shellType.InvokeMember(
                "CreateShortcut",
                System.Reflection.BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { shortcutPath });
            var type = shortcut!.GetType();
            var target = type.InvokeMember(
                "TargetPath",
                System.Reflection.BindingFlags.GetProperty,
                null,
                shortcut,
                null) as string ?? "";
            var arguments = type.InvokeMember(
                "Arguments",
                System.Reflection.BindingFlags.GetProperty,
                null,
                shortcut,
                null) as string ?? "";
            var workingDirectory = type.InvokeMember(
                "WorkingDirectory",
                System.Reflection.BindingFlags.GetProperty,
                null,
                shortcut,
                null) as string ?? "";
            var iconLocation = type.InvokeMember(
                "IconLocation",
                System.Reflection.BindingFlags.GetProperty,
                null,
                shortcut,
                null) as string ?? "";
            var normalizedRoot = Path.GetFullPath(installRoot)
                .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!string.IsNullOrWhiteSpace(target))
            {
                var normalizedTarget = Path.GetFullPath(target);
                if (normalizedTarget.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            var launcher = Path.Combine(installRoot, "Byeollog-Launcher.ps1");
            if (arguments.Contains(launcher, StringComparison.OrdinalIgnoreCase)) return true;

            // 일부 Windows Shell 버전은 WScript로 만든 direct EXE 링크의
            // TargetPath를 빈 문자열로 되돌립니다. 이때는 우리가 함께 기록한
            // 작업 폴더와 아이콘이 모두 같은 고정 설치 루트 안일 때만 소유로 봅니다.
            var iconPath = iconLocation.Split(',')[0].Trim().Trim('"');
            if (string.IsNullOrWhiteSpace(workingDirectory) || string.IsNullOrWhiteSpace(iconPath))
                return false;
            var normalizedWorkingDirectory = Path.GetFullPath(workingDirectory)
                .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var normalizedIconPath = Path.GetFullPath(iconPath);
            return normalizedWorkingDirectory.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)
                && normalizedIconPath.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private sealed record ManagedContext(string InstallRoot, string RunningExecutable, string PointerPath);
}
