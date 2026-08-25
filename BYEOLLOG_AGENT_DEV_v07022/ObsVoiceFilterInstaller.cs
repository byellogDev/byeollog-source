using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;

namespace HurogiCollector;

internal sealed record ObsVoiceFilterInstallResult(
    bool Changed,
    bool ObsRestartRequired,
    string PluginPath);

internal static class ObsVoiceFilterInstaller
{
    internal const string FilterKind = "byeollog_voice_filter_v1";
    internal const string PluginFileName = "byeollog-voice-filter.dll";
    internal const string PluginSha256 = "79d464f9a5508ab0ccf96d7d081cba674faddc1eddb06d09eae612b0e38750a8";

    private const string PluginResource = "HurogiCollector.Native.byeollog-voice-filter.dll";
    private const string NoticesResource = "HurogiCollector.ObsPlugin.byeollog-voice-filter.THIRD_PARTY_NOTICES.txt";
    private const string GplResource = "HurogiCollector.ObsPlugin.byeollog-voice-filter.COPYING_GPL-2.0.txt";
    private static readonly (string Resource, string RelativePath)[] SourcePayload =
    {
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.plugin.cpp", "plugin.cpp"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.obs.def", "obs.def"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.Build-VoiceFilter.ps1", "Build-VoiceFilter.ps1"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.README.md", "README.md"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.vendor.signalsmith-stretch.signalsmith-stretch.h", "vendor/signalsmith-stretch/signalsmith-stretch.h"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.vendor.signalsmith-stretch.LICENSE.txt", "vendor/signalsmith-stretch/LICENSE.txt"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.vendor.signalsmith-linear.stft.h", "vendor/signalsmith-linear/stft.h"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.vendor.signalsmith-linear.fft.h", "vendor/signalsmith-linear/fft.h"),
        ("HurogiCollector.ObsPlugin.byeollog-voice-filter.Source.vendor.signalsmith-linear.LICENSE.txt", "vendor/signalsmith-linear/LICENSE.txt")
    };

    internal static string PluginRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "obs-studio",
        "plugins",
        "byeollog-voice-filter");

    internal static string PluginPath => Path.Combine(
        PluginRoot,
        "bin",
        "64bit",
        PluginFileName);

    internal static async Task<ObsVoiceFilterInstallResult> EnsureInstalledAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var pluginWasCurrent = string.Equals(
            TryFileSha256(PluginPath),
            PluginSha256,
            StringComparison.Ordinal);
        try
        {
            return InstallEmbeddedPayload();
        }
        catch (Exception ex) when (NeedsElevation(ex))
        {
            var exitCode = await RunElevatedInstallerAsync(cancellationToken);
            if (exitCode != 0)
                throw new InvalidOperationException(
                    "별록 OBS 음성 필터 설치 권한을 받지 못했습니다. 다시 시도해주세요.");
            var installedHash = TryFileSha256(PluginPath);
            if (!string.Equals(installedHash, PluginSha256, StringComparison.Ordinal))
                throw new InvalidDataException("설치된 별록 OBS 음성 필터의 무결성을 확인하지 못했습니다.");
            return new(true, !pluginWasCurrent && IsObsRunning(), PluginPath);
        }
    }

    internal static int RunElevatedInstallCommand()
    {
        try
        {
            _ = InstallEmbeddedPayload();
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static ObsVoiceFilterInstallResult InstallEmbeddedPayload()
    {
        var pluginBytes = ReadResource(PluginResource);
        var embeddedHash = Convert.ToHexString(SHA256.HashData(pluginBytes)).ToLowerInvariant();
        if (!string.Equals(embeddedHash, PluginSha256, StringComparison.Ordinal))
            throw new InvalidDataException("내장된 별록 OBS 음성 필터의 무결성이 올바르지 않습니다.");

        var currentHash = TryFileSha256(PluginPath);
        var pluginChanged = !string.Equals(currentHash, PluginSha256, StringComparison.Ordinal);

        if (pluginChanged && currentHash is not null && IsObsRunning())
            throw new InvalidOperationException(
                "OBS가 이전 별록 음성 필터를 사용 중입니다. OBS를 완전히 종료한 뒤 다시 준비해주세요.");

        Directory.CreateDirectory(Path.GetDirectoryName(PluginPath)!);
        Directory.CreateDirectory(Path.Combine(PluginRoot, "data"));
        var changed = false;
        if (pluginChanged)
        {
            WriteAtomically(PluginPath, pluginBytes);
            changed = true;
        }
        changed |= WriteIfDifferentAtomically(
            Path.Combine(PluginRoot, "THIRD_PARTY_NOTICES.txt"),
            ReadResource(NoticesResource));
        changed |= WriteIfDifferentAtomically(
            Path.Combine(PluginRoot, "COPYING_GPL-2.0.txt"),
            ReadResource(GplResource));
        var sourceRoot = Path.Combine(PluginRoot, "source");
        foreach (var (resource, relativePath) in SourcePayload)
        {
            var destination = Path.Combine(
                sourceRoot,
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            changed |= WriteIfDifferentAtomically(destination, ReadResource(resource));
        }

        var installedHash = TryFileSha256(PluginPath);
        if (!string.Equals(installedHash, PluginSha256, StringComparison.Ordinal))
            throw new InvalidDataException("설치된 별록 OBS 음성 필터의 무결성을 확인하지 못했습니다.");
        return new(changed, pluginChanged && IsObsRunning(), PluginPath);
    }

    private static async Task<int> RunElevatedInstallerAsync(CancellationToken cancellationToken)
    {
        var executable = Environment.ProcessPath ?? Application.ExecutablePath;
        var start = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.ArgumentList.Add("--install-obs-voice-plugin");
        try
        {
            using var process = Process.Start(start)
                ?? throw new InvalidOperationException("별록 OBS 음성 필터 설치 프로세스를 시작하지 못했습니다.");
            await process.WaitForExitAsync(cancellationToken);
            return process.ExitCode;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return 1223;
        }
    }

    private static bool NeedsElevation(Exception ex) => ex is UnauthorizedAccessException
        || ex is IOException io && io.HResult is unchecked((int)0x80070005) or unchecked((int)0x80070020);

    private static bool IsObsRunning()
    {
        try { return Process.GetProcessesByName("obs64").Length > 0; }
        catch { return true; }
    }

    private static string? TryFileSha256(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static byte[] ReadResource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"내장 OBS 플러그인 리소스를 찾지 못했습니다: {name}");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    private static void WriteAtomically(string path, byte[] content)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("OBS 플러그인 설치 경로가 올바르지 않습니다.");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(
                       temporary,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       64 * 1024,
                       FileOptions.WriteThrough))
            {
                stream.Write(content);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    private static bool WriteIfDifferentAtomically(string path, byte[] content)
    {
        try
        {
            if (File.Exists(path))
            {
                var existing = File.ReadAllBytes(path);
                if (existing.AsSpan().SequenceEqual(content)) return false;
            }
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }

        WriteAtomically(path, content);
        return true;
    }
}
