using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record CollectorStatePreparationReport(
    int SchemaVersion,
    string AppVersion,
    bool SnapshotCreated,
    string SnapshotPath,
    IReadOnlyList<string> ValidatedFiles,
    IReadOnlyList<string> RestoredFiles);

internal sealed record CollectorStateSnapshotEntry(
    string RelativePath,
    long ByteSize,
    string Sha256);

internal sealed record CollectorStateSnapshotManifest(
    int SchemaVersion,
    string AppVersion,
    DateTimeOffset CreatedAtUtc,
    IReadOnlyList<CollectorStateSnapshotEntry> Files);

/// <summary>
/// Guards persistent Collector state before a new binary touches it.
/// The application directory may roll forward/back independently; user state remains in
/// %LOCALAPPDATA%\ByeollogAgent and receives a one-time, hash-manifested pre-version snapshot.
/// </summary>
internal static class CollectorStateLifecycle
{
    internal const int CurrentSchemaVersion = 1;
    private const int MaxSmallStateBytes = 4 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private static readonly string[] ValidatedStateFiles =
    {
        "collector_config.json",
        "obs_settings.json",
        "windows_capture_settings.json",
        "vnext_agent_credentials.json",
        "session_state.json",
        "next_broadcast_roulette_rules.json",
        "next_broadcast_fixed_rules.json",
        "theme.txt"
    };

    private static readonly string[] SnapshotFiles =
    {
        "collector_config.json",
        "obs_settings.json",
        "windows_capture_settings.json",
        "vnext_agent_credentials.json",
        "session_state.json",
        "next_broadcast_roulette_rules.json",
        "next_broadcast_fixed_rules.json",
        "theme.txt",
        "account_login.ok",
        "streamer_name.txt",
        "remembered_login_id.txt",
        "seen_uids.txt",
        "donations.jsonl",
        "uploaded_event_keys.txt",
        "vnext_dev_uploaded_event_keys.txt",
        "timed_mute_recovery.json",
        "vnext_agent.sqlite",
        "vnext_agent.sqlite-wal",
        "vnext_agent.sqlite-shm"
    };

    private static readonly string[] SnapshotDirectories =
    {
        "sessions",
        "session_rules",
        "session_fixed_rules"
    };

    internal static CollectorStatePreparationReport Prepare(string root, string appVersion)
    {
        if (string.IsNullOrWhiteSpace(root))
            throw new ArgumentException("Collector state root is required", nameof(root));
        if (string.IsNullOrWhiteSpace(appVersion) || appVersion.Length > 80)
            throw new ArgumentException("Collector app version is invalid", nameof(appVersion));

        root = Path.GetFullPath(root);
        Directory.CreateDirectory(root);

        var snapshot = CreateSnapshotOnce(root, appVersion);
        var restored = new List<string>();
        var validated = new List<string>();

        var schemaPath = Path.Combine(root, "state-schema.json");
        var installedSchema = ReadInstalledSchema(schemaPath);
        if (installedSchema > CurrentSchemaVersion)
        {
            throw new InvalidOperationException(
                "이 설정은 더 새로운 별록 에이전트에서 사용되었습니다. " +
                "설정 파일을 수정하지 말고 최신 버전으로 실행해주세요.");
        }

        foreach (var fileName in ValidatedStateFiles)
        {
            var path = Path.Combine(root, fileName);
            if (!File.Exists(path)) continue;
            if (!ValidateStateFile(path, fileName, out _))
            {
                var backup = path + ".bak";
                if (!File.Exists(backup) || !ValidateStateFile(backup, fileName, out _))
                {
                    throw new InvalidDataException(
                        $"별록 설정 파일 '{fileName}'이 손상되었고 안전한 이전 사본이 없습니다. " +
                        "파일을 삭제하지 말고 진단 자료와 함께 관리자에게 전달해주세요.");
                }

                PreserveCorruptAndRestore(path, backup);
                restored.Add(fileName);
            }

            validated.Add(fileName);
        }

        var schemaNeedsWrite = installedSchema != CurrentSchemaVersion ||
            !SchemaMatchesVersion(schemaPath, appVersion);
        if (schemaNeedsWrite)
        {
            AtomicWriteText(
                schemaPath,
                JsonSerializer.Serialize(new
                {
                    schemaVersion = CurrentSchemaVersion,
                    appVersion,
                    preparedAtUtc = DateTimeOffset.UtcNow
                }, Json));
        }

        return new CollectorStatePreparationReport(
            CurrentSchemaVersion,
            appVersion,
            snapshot.Created,
            snapshot.Path,
            validated,
            restored);
    }

    internal static void AtomicWriteText(string path, string contents)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        contents ??= "";
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath)
            ?? throw new InvalidOperationException("State path has no parent directory");
        Directory.CreateDirectory(directory);

        var temporary = fullPath + ".tmp-" + Guid.NewGuid().ToString("N");
        var backupTemporary = fullPath + ".bak-tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            WriteDurably(temporary, Utf8NoBom.GetBytes(contents));
            if (File.Exists(fullPath))
            {
                File.Copy(fullPath, backupTemporary, overwrite: false);
                File.Move(backupTemporary, fullPath + ".bak", overwrite: true);
            }
            File.Move(temporary, fullPath, overwrite: true);
        }
        finally
        {
            TryDelete(temporary);
            TryDelete(backupTemporary);
        }
    }

    internal static void AtomicWriteLines(string path, IEnumerable<string> lines)
    {
        var materialized = lines.ToList();
        AtomicWriteText(
            path,
            materialized.Count == 0
                ? ""
                : string.Join(Environment.NewLine, materialized) + Environment.NewLine);
    }

    private static (bool Created, string Path) CreateSnapshotOnce(string root, string appVersion)
    {
        var versionKey = new string(appVersion
            .Select(character => char.IsLetterOrDigit(character) ? character : '-')
            .ToArray()).Trim('-');
        if (versionKey.Length == 0) versionKey = "unknown";

        var backupRoot = Path.Combine(root, "state-backups");
        Directory.CreateDirectory(backupRoot);
        var final = Path.Combine(backupRoot, "before-" + versionKey);
        if (Directory.Exists(final)) return (false, final);

        var staging = final + ".staging-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(staging);
        try
        {
            var entries = new List<CollectorStateSnapshotEntry>();
            foreach (var fileName in SnapshotFiles)
            {
                var source = Path.Combine(root, fileName);
                if (File.Exists(source)) CopySnapshotFile(root, staging, source, entries);
            }

            foreach (var directoryName in SnapshotDirectories)
            {
                var sourceDirectory = Path.Combine(root, directoryName);
                if (!Directory.Exists(sourceDirectory)) continue;
                foreach (var source in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.AllDirectories))
                {
                    CopySnapshotFile(root, staging, source, entries);
                }
            }

            entries.Sort((left, right) => string.CompareOrdinal(left.RelativePath, right.RelativePath));
            var manifest = new CollectorStateSnapshotManifest(
                CurrentSchemaVersion,
                appVersion,
                DateTimeOffset.UtcNow,
                entries);
            var manifestPath = Path.Combine(staging, "snapshot-manifest.json");
            WriteDurably(
                manifestPath,
                Utf8NoBom.GetBytes(JsonSerializer.Serialize(manifest, Json)));

            Directory.Move(staging, final);
            return (true, final);
        }
        catch
        {
            TryDeleteDirectory(staging);
            throw;
        }
    }

    private static void CopySnapshotFile(
        string root,
        string staging,
        string source,
        List<CollectorStateSnapshotEntry> entries)
    {
        var relative = Path.GetRelativePath(root, source).Replace('\\', '/');
        if (relative.StartsWith("../", StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new InvalidOperationException("State snapshot path escaped its root");

        var destination = Path.Combine(staging, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Copy(source, destination, overwrite: false);
        var info = new FileInfo(destination);
        string sha256;
        using (var stream = File.OpenRead(destination))
            sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        entries.Add(new CollectorStateSnapshotEntry(
            relative,
            info.Length,
            sha256));
    }

    private static int ReadInstalledSchema(string path)
    {
        if (!File.Exists(path)) return 0;
        try
        {
            var info = new FileInfo(path);
            if (info.Length <= 0 || info.Length > MaxSmallStateBytes)
                throw new InvalidDataException("State schema file size is invalid");
            using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !TryGetPropertyIgnoreCase(document.RootElement, "schemaVersion", out var value) ||
                !value.TryGetInt32(out var schema) || schema < 1)
                throw new InvalidDataException("State schema file is invalid");
            return schema;
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("State schema file is invalid", ex);
        }
    }

    private static bool SchemaMatchesVersion(string path, string appVersion)
    {
        if (!File.Exists(path)) return false;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
            return TryGetPropertyIgnoreCase(document.RootElement, "appVersion", out var value) &&
                value.ValueKind == JsonValueKind.String &&
                string.Equals(value.GetString(), appVersion, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static bool ValidateStateFile(string path, string logicalName, out string reason)
    {
        try
        {
            var info = new FileInfo(path);
            if (info.Length <= 0 || info.Length > MaxSmallStateBytes)
            {
                reason = "size";
                return false;
            }

            if (logicalName == "theme.txt")
            {
                var theme = File.ReadAllText(path, Encoding.UTF8).Trim();
                reason = theme is "light" or "dark" ? "ok" : "theme";
                return reason == "ok";
            }

            using var document = JsonDocument.Parse(
                File.ReadAllText(path, Encoding.UTF8),
                new JsonDocumentOptions { MaxDepth = 48 });
            var root = document.RootElement;
            var valid = logicalName switch
            {
                "collector_config.json" =>
                    root.ValueKind == JsonValueKind.Object &&
                    HasKind(root, "ServerUrl", JsonValueKind.String) &&
                    HasKind(root, "CollectorToken", JsonValueKind.String),
                "obs_settings.json" =>
                    root.ValueKind == JsonValueKind.Object &&
                    HasKind(root, "Enabled", JsonValueKind.True, JsonValueKind.False) &&
                    HasKind(root, "Port", JsonValueKind.Number) &&
                    HasKind(root, "MicrophoneInputName", JsonValueKind.String) &&
                    HasKind(root, "Password", JsonValueKind.String),
                "windows_capture_settings.json" =>
                    root.ValueKind == JsonValueKind.Object &&
                    HasKind(root, "Enabled", JsonValueKind.True, JsonValueKind.False) &&
                    HasKind(root, "EndpointId", JsonValueKind.String) &&
                    HasKind(root, "EndpointName", JsonValueKind.String),
                "vnext_agent_credentials.json" =>
                    root.ValueKind == JsonValueKind.Object &&
                    HasKind(root, "DeviceSecret", JsonValueKind.String),
                "session_state.json" =>
                    root.ValueKind == JsonValueKind.Object &&
                    HasKind(root, "Id", JsonValueKind.String) &&
                    HasKind(root, "StartLocal", JsonValueKind.String) &&
                    HasKind(root, "Active", JsonValueKind.True, JsonValueKind.False),
                "next_broadcast_roulette_rules.json" or "next_broadcast_fixed_rules.json" =>
                    root.ValueKind == JsonValueKind.Array,
                _ => false
            };
            reason = valid ? "ok" : "shape";
            return valid;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            reason = ex.GetType().Name;
            return false;
        }
    }

    private static bool HasKind(JsonElement root, string name, params JsonValueKind[] allowed)
    {
        return TryGetPropertyIgnoreCase(root, name, out var value) &&
            allowed.Contains(value.ValueKind);
    }

    private static bool TryGetPropertyIgnoreCase(JsonElement root, string name, out JsonElement value)
    {
        foreach (var property in root.EnumerateObject())
        {
            if (!string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
            value = property.Value;
            return true;
        }
        value = default;
        return false;
    }

    private static void PreserveCorruptAndRestore(string path, string backup)
    {
        var corrupt = path + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" +
            Guid.NewGuid().ToString("N")[..6];
        File.Move(path, corrupt, overwrite: false);
        var temporary = path + ".restore-" + Guid.NewGuid().ToString("N");
        try
        {
            File.Copy(backup, temporary, overwrite: false);
            File.Move(temporary, path, overwrite: false);
        }
        catch
        {
            TryDelete(temporary);
            if (!File.Exists(path) && File.Exists(corrupt)) File.Move(corrupt, path, overwrite: false);
            throw;
        }
    }

    private static void WriteDurably(string path, byte[] bytes)
    {
        using var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 16 * 1024,
            options: FileOptions.WriteThrough);
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); } catch { }
    }
}
